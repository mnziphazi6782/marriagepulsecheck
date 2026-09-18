/**
 * Marriage Pulse Check — Lead Capture Backend
 * Open source, self-hosted. No paid services required.
 *
 * What this does:
 *  - Accepts POST /api/submit from marriage_pulse_check.html
 *  - Stores each lead (name, email, scores, timestamp) in a local SQLite file
 *  - Lets you view all leads at GET /api/leads (protect this in production!)
 *  - Optionally forwards each new lead to MailerLite so they land straight
 *    in your email list (fill in MAILERLITE_API_KEY + MAILERLITE_GROUP_ID below)
 *
 * Requirements: Node.js 18+
 * Install:  npm install
 * Run:      npm start
 */

const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(cors());              // during setup; tighten to your domain before going live
app.use(express.json());

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-secret"; // protects /api/leads

// Optional: forward leads straight into your MailerLite list.
// Leave MAILERLITE_API_KEY blank to skip this step entirely.
const MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY || "";
const MAILERLITE_GROUP_ID = process.env.MAILERLITE_GROUP_ID || "";

// ---------- DATABASE ----------
const db = new Database(path.join(__dirname, "leads.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    total INTEGER,
    tier TEXT,
    weakest TEXT,
    scores TEXT,
    answers TEXT,
    submitted_at TEXT
  )
`);

// ---------- ROUTES ----------

// Health check
app.get("/", (req, res) => res.send("Marriage Pulse Check backend is running."));

// Receive a new submission from the quiz
app.post("/api/submit", async (req, res) => {
  const { name, email, total, tier, weakest, scores, answers, submittedAt } = req.body || {};

  if (!name || !email) {
    return res.status(400).json({ ok: false, error: "Missing name or email" });
  }

  db.prepare(`
    INSERT INTO leads (name, email, total, tier, weakest, scores, answers, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, email, total || null, tier || null, weakest || null,
    JSON.stringify(scores || {}), JSON.stringify(answers || []),
    submittedAt || new Date().toISOString()
  );

  // Optional: push to MailerLite so the lead lands in your list automatically
  if (MAILERLITE_API_KEY && MAILERLITE_GROUP_ID) {
    try {
      await fetch(`https://connect.mailerlite.com/api/subscribers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${MAILERLITE_API_KEY}`,
        },
        body: JSON.stringify({
          email,
          fields: { name },
          groups: [MAILERLITE_GROUP_ID],
        }),
      });
    } catch (err) {
      console.error("MailerLite sync failed:", err.message);
      // We don't fail the request just because the email sync failed —
      // the lead is already safely stored in the local database.
    }
  }

  res.json({ ok: true });
});

// View all captured leads (simple protection via a shared key — see README)
app.get("/api/leads", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const rows = db.prepare("SELECT * FROM leads ORDER BY id DESC").all();
  res.json(rows);
});

// Export all leads as CSV (handy for importing into MailerLite / Excel)
app.get("/api/leads.csv", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("Unauthorized");
  }
  const rows = db.prepare("SELECT * FROM leads ORDER BY id DESC").all();
  const header = "id,name,email,total,tier,weakest,submitted_at\n";
  const body = rows.map(r =>
    [r.id, r.name, r.email, r.total, r.tier, r.weakest, r.submitted_at].join(",")
  ).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.send(header + body);
});

app.listen(PORT, () => {
  console.log(`Marriage Pulse Check backend running on port ${PORT}`);
});
