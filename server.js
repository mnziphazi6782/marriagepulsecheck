/**
 * Marriage Pulse Check — Lead Capture Backend (v2)
 *
 * WHY THIS VERSION EXISTS
 * -----------------------
 * v1 used better-sqlite3, which must compile C++ code during install.
 * On Render's newer Node versions there are no prebuilt binaries, so the
 * build failed. This version has ZERO native dependencies — it installs
 * instantly on any Node version, on any host.
 *
 * It also fixes a quieter problem: Render's free tier has an EPHEMERAL
 * filesystem. Any local database file is wiped whenever the service
 * restarts or redeploys. So local storage here is only a short-term
 * convenience buffer — MailerLite is the durable system of record.
 *
 * Requirements: Node.js 18+
 * Install:  npm install
 * Run:      npm start
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ---------- CONFIG (set these as Environment Variables in Render) ----------
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-secret";

// MailerLite is the durable store. Strongly recommended — without it,
// leads only survive until the next restart on a free hosting tier.
const MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY || "";
const MAILERLITE_GROUP_ID = process.env.MAILERLITE_GROUP_ID || "";

// ---------- LOCAL BUFFER (best-effort, not permanent storage) ----------
const DATA_FILE = path.join(__dirname, "leads.json");
let leads = [];

try {
  if (fs.existsSync(DATA_FILE)) {
    leads = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  }
} catch (err) {
  console.error("Could not read existing leads file, starting fresh:", err.message);
  leads = [];
}

function persist() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
  } catch (err) {
    // On read-only or ephemeral filesystems this can fail. That's survivable:
    // the lead is still in memory and already sent to MailerLite.
    console.error("Local write failed (expected on some hosts):", err.message);
  }
}

// ---------- ROUTES ----------

app.get("/", (req, res) => {
  res.send("Marriage Pulse Check backend is running. Leads captured this session: " + leads.length);
});

// Receive a completed assessment
app.post("/api/submit", async (req, res) => {
  const { name, email, total, tier, weakest, scores, answers, submittedAt } = req.body || {};

  if (!name || !email || !String(email).includes("@")) {
    return res.status(400).json({ ok: false, error: "Missing or invalid name/email" });
  }

  const lead = {
    id: leads.length + 1,
    name: String(name).slice(0, 120),
    email: String(email).slice(0, 200).toLowerCase(),
    total: total ?? null,
    tier: tier ?? null,
    weakest: weakest ?? null,
    scores: scores ?? {},
    answers: answers ?? [],
    submittedAt: submittedAt || new Date().toISOString(),
  };

  leads.push(lead);
  persist();

  let mailerliteOk = null;

  if (MAILERLITE_API_KEY && MAILERLITE_GROUP_ID) {
    try {
      const body = {
        email: lead.email,
        fields: {
          name: lead.name,
          // Custom fields — create these in MailerLite first (see setup guide).
          pulse_tier: lead.tier || "",
          pulse_total: lead.total != null ? String(lead.total) : "",
          pulse_focus: lead.weakest || "",
        },
        groups: [MAILERLITE_GROUP_ID],
      };

      const r = await fetch("https://connect.mailerlite.com/api/subscribers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${MAILERLITE_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      mailerliteOk = r.ok;
      if (!r.ok) {
        const text = await r.text();
        console.error("MailerLite rejected the subscriber:", r.status, text);
      }
    } catch (err) {
      mailerliteOk = false;
      console.error("MailerLite request failed:", err.message);
    }
  }

  // Always succeed for the user — they should see their results either way.
  res.json({ ok: true, mailerlite: mailerliteOk });
});

// View leads captured since the last restart
app.get("/api/leads", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  res.json(leads.slice().reverse());
});

// Diagnostic: ask MailerLite directly for your groups and their correct numeric IDs.
// Visit /api/mailerlite-groups?key=YOUR_ADMIN_KEY in a browser to use this.
app.get("/api/mailerlite-groups", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (!MAILERLITE_API_KEY) {
    return res.status(400).json({ ok: false, error: "MAILERLITE_API_KEY is not set on this server." });
  }

  try {
    const r = await fetch("https://connect.mailerlite.com/api/groups", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${MAILERLITE_API_KEY}`,
      },
    });
    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, mailerliteStatus: r.status, mailerliteResponse: data });
    }

    const groups = (data.data || []).map((g) => ({
      name: g.name,
      id: g.id,
      typeof_id: typeof g.id,
    }));

    res.json({ ok: true, groups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Export as CSV
app.get("/api/leads.csv", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("Unauthorized");
  }
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = "id,name,email,total,tier,weakest,submitted_at\n";
  const body = leads
    .slice()
    .reverse()
    .map((r) => [r.id, r.name, r.email, r.total, r.tier, r.weakest, r.submittedAt].map(esc).join(","))
    .join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="pulse-check-leads.csv"');
  res.send(header + body);
});

app.listen(PORT, () => {
  console.log(`Marriage Pulse Check backend running on port ${PORT}`);
  if (!MAILERLITE_API_KEY) {
    console.warn("WARNING: MailerLite is not configured. Leads will NOT survive a restart.");
  }
});
