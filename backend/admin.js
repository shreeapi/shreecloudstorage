import express from "express";
import rateLimit from "express-rate-limit";
import { Users, Files, Folders, BannedIps, RequestStats } from "./db.js";
import { getLogs, getLogById, logsOverview } from "./requestLogs.js";
import "dotenv/config";

const router = express.Router();

// Credentials are read from env with the values you gave as defaults, so the
// panel works out of the box — but PLEASE move these to your real .env and
// change the password before deploying anywhere public. Hardcoded/default
// admin credentials in source are a real risk if this repo is ever public.
const ADMIN_ID = process.env.ADMIN_ID || "anshapi@ansh";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "@Ansh1437";

// Admin login was previously unlimited — a real brute-force gap for a
// password protecting this much. Same shape as the site's other login limiters.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin login attempts. Please wait a few minutes." },
});

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) return res.status(401).json({ error: "Admin login required" });
  next();
}

router.post("/login", adminLoginLimiter, (req, res) => {
  const { id, password } = req.body;
  if (id === ADMIN_ID && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Invalid admin credentials" });
});

router.post("/logout", (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  res.json({ isAdmin: !!req.session?.isAdmin });
});

// ---------------------------------------------------------------------------
// Everything below is METADATA ONLY. We deliberately never decrypt or expose
// `encrypted_session` here — that string is equivalent to a live login to a
// user's real Telegram account, and no admin panel should be able to read or
// reuse it. What you get instead: who's using the product, how much storage
// they're using, and when they were last active.
// ---------------------------------------------------------------------------

function storageForUser(userId) {
  return Files.all()
    .filter((f) => f.user_id === userId)
    .reduce((sum, f) => sum + (f.size || 0), 0);
}

router.get("/overview", requireAdmin, (req, res) => {
  const users = Users.all();
  const files = Files.all();
  const totalStorage = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const activeToday = users.filter((u) => (u.last_active || 0) > dayAgo).length;

  res.json({
    totalUsers: users.length,
    totalFiles: files.length,
    totalStorageBytes: totalStorage,
    activeToday,
  });
});

router.get("/users", requireAdmin, (req, res) => {
  const users = Users.all().map((u) => ({
    id: u.id,
    // Phone is partially masked for privacy even within the admin panel.
    phone: u.phone ? u.phone.replace(/(\d{3})\d+(\d{2})$/, "$1••••$2") : "—",
    created_at: u.created_at,
    last_login: u.last_login,
    last_active: u.last_active,
    fileCount: Files.all().filter((f) => f.user_id === u.id).length,
    storageBytes: storageForUser(u.id),
  }));
  res.json({ users });
});

// Step-up verification: even though you're already logged into the admin
// panel, seeing FULL unmasked phone numbers requires re-entering the admin
// password. This isn't stored as a session flag — it's a one-shot check per
// request, so unmasked data is only ever returned in direct response to a
// fresh password confirmation, not left toggled on indefinitely.
router.post("/users/unmask", requireAdmin, rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes." },
}), (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  const users = Users.all().map((u) => ({
    id: u.id,
    phone: u.phone || "—",
    created_at: u.created_at,
    last_login: u.last_login,
    last_active: u.last_active,
    fileCount: Files.all().filter((f) => f.user_id === u.id).length,
    storageBytes: storageForUser(u.id),
  }));
  res.json({ users });
});

router.get("/files", requireAdmin, (req, res) => {
  const users = Users.all();
  const files = Files.all().map((f) => {
    const owner = users.find((u) => u.id === f.user_id);
    return {
      id: f.id,
      filename: f.filename,
      mimetype: f.mimetype,
      size: f.size,
      visibility: f.visibility,
      created_at: f.created_at,
      ownerPhone: owner ? owner.phone.replace(/(\d{3})\d+(\d{2})$/, "$1••••$2") : "unknown",
    };
  });
  res.json({ files });
});

// ---------------------------------------------------------------------------
// Request/traffic management — tracks visits by IP (see the middleware in
// server.js), lets the admin ban an IP outright (banned IPs get a 403 on
// every route, before anything else runs), and feeds the traffic graph.
// ---------------------------------------------------------------------------

router.get("/requests/overview", requireAdmin, (req, res) => {
  res.json(RequestStats.overview());
});

router.get("/requests/ips", requireAdmin, (req, res) => {
  res.json({ ips: RequestStats.ipList() });
});

router.get("/requests/daily", requireAdmin, (req, res) => {
  res.json({ series: RequestStats.dailySeries(14) });
});

router.post("/requests/ban", requireAdmin, async (req, res) => {
  const { ip, reason } = req.body;
  if (!ip) return res.status(400).json({ error: "ip required" });
  await BannedIps.ban(ip, reason || "");
  res.json({ ok: true });
});

router.post("/requests/unban", requireAdmin, async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: "ip required" });
  await BannedIps.unban(ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Request Logs — per-request inspector (method/path/status/latency/IP/
// country) with a captured response-body preview, for debugging traffic at
// a glance. Kept in-memory only (see requestLogs.js), capped to the most
// recent 2000 requests — this is a debugging aid, not a permanent audit log.
// ---------------------------------------------------------------------------

router.get("/requests/logs", requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const before = req.query.before || null;
  res.json({ logs: getLogs({ limit, before }) });
});

router.get("/requests/logs/:id", requireAdmin, (req, res) => {
  const log = getLogById(req.params.id);
  if (!log) return res.status(404).json({ error: "Log not found (it may have rotated out of the in-memory buffer)" });
  res.json({ log });
});

router.get("/requests/logs-overview", requireAdmin, (req, res) => {
  res.json(logsOverview());
});

export default router;
