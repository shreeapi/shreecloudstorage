import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import multer from "multer";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import os from "os";
import path from "path";
import "dotenv/config";

import { Users, Files, Folders, BannedIps, RequestStats } from "./db.js";
import { recordLog, truncateBody, countryForIp } from "./requestLogs.js";
import {
  sendLoginCode,
  verifyLoginCode,
  encryptSession,
  decryptSession,
  getPooledClient,
  uploadToSavedMessages,
  renameSavedMessage,
  findSavedMessage,
  iterDownloadRange,
  startQrLogin,
  getQrLoginState,
  submitQrPassword,
  cleanupQrLogin,
  getProfileInfo,
  getProfilePhotoBuffer,
  backupUploadBestEffort,
  isAuthError,
  evictPooledClient,
} from "./telegramClient.js";
import QRCode from "qrcode";
import adminRouter from "./admin.js";
import apiRouter, { generateApiKey } from "./api.js";

const app = express();

// Railway (and most PaaS platforms) terminate TLS at a reverse proxy in
// front of the app, then forward plain HTTP internally. Without this,
// Express/cookie-session can misjudge whether the connection is "secure",
// which matters for the Secure cookie flag required by cross-domain
// SameSite=None cookies.
app.set("trust proxy", 1);

// In split deployment (frontend on Vercel, backend on Railway), these are
// different origins, so credentialed requests need an explicit allowed
// origin (not `origin: true`/wildcard) and cookies need SameSite=None +
// Secure. In local dev, FRONTEND_URL is unset and this falls back to
// permissive settings that work with Vite's same-origin proxy.
const FRONTEND_URL = process.env.FRONTEND_URL; // e.g. https://teracloud.vercel.app
const isProd = process.env.NODE_ENV === "production";

app.use(cors({
  origin: FRONTEND_URL || true,
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }));

// --- Security hardening ---
// Note: no setup makes a public web app "unscrapable" — anything a browser
// can render, a determined scraper can eventually fetch too. What we CAN do
// is remove easy wins: fingerprinting headers, unlimited brute-force
// attempts on auth/login endpoints, and unlimited hits on expensive routes.
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // needed so <video>/<img> can load from a different origin (Vercel)
  hsts: { maxAge: 31536000, includeSubDomains: true }, // force HTTPS on repeat visits for a year
}));
app.disable("x-powered-by");

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});
// QR login has its own limiter, separate from phone-code send/verify. It was
// previously sharing authLimiter's bucket, which meant many users behind the
// same shared IP (common on mobile carrier NATs) could exhaust each other's
// combined login attempts across BOTH methods — explaining "works for some
// people, not others" on the same network. QR scanning also isn't a
// brute-force target the way a typed code/password is, so a higher, IP-wide
// ceiling here is safe.
const qrLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many QR login attempts from this network. Please wait a few minutes and try again." },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Max 60 requests/minute." },
});

// General site-wide limiter. The specific limiters above (auth, QR, API key)
// stay in place for their sensitive routes; this is a broader net so no
// single IP can hammer the whole app (any route) at an abusive rate — more
// important now that this serves a large public user base, not a handful
// of people.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});
app.use(globalLimiter);

// Origin check on state-changing requests (CSRF mitigation).
// Cross-domain deployment requires SameSite=None cookies (see below), which
// on its own doesn't stop a malicious third-party page from auto-submitting
// a form that rides along with a logged-in user's cookies. Modern browsers
// send an Origin header on cross-site POSTs (including plain form
// submissions), so rejecting requests whose Origin doesn't match our own
// frontend blocks that class of attack without needing full CSRF tokens.
app.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.headers.origin;
  // No Origin header at all (e.g. same-origin requests in some browsers, or
  // non-browser API clients using the X-API-Key header instead of cookies)
  // is allowed through — this check specifically targets cookie-riding
  // cross-site requests, which always carry an Origin header in practice.
  if (!origin) return next();
  const allowed = FRONTEND_URL || (!isProd ? true : null);
  if (allowed === true || origin === FRONTEND_URL) return next();
  return res.status(403).json({ error: "Request origin not allowed." });
});

app.use(
  cookieSession({
    name: "tgdrive_session",
    keys: [process.env.COOKIE_SECRET || "dev_secret"],
    maxAge: 30 * 60 * 60 * 24 * 1000,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
  })
);

// ---------------------------------------------------------------------------
// Request tracking + IP ban enforcement + detailed request logging.
// Every request's IP is logged (in-memory, flushed to disk periodically —
// see db.js) for the admin dashboard's traffic stats. Banned IPs are
// rejected here, before any other route runs — EXCEPT an active admin
// session, which is deliberately exempt. Without that exemption, an admin
// could accidentally ban their own IP (easy to do by mistake) and lock
// themselves out of the panel that's the only place to undo it.
//
// A detailed log (method, path, status, latency, IP, country, and a capped
// preview of the JSON response body) is also captured for the admin's
// Request Logs / inspector view. This is kept in-memory only (see
// requestLogs.js) — persisting every request to disk wouldn't scale.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  if (BannedIps.isBanned(ip) && !req.session?.isAdmin) {
    return res.status(403).json({ error: "Access denied." });
  }
  RequestStats.recordRequest(ip);

  const startTime = Date.now();
  let capturedBody = null;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    capturedBody = body;
    return originalJson(body);
  };

  res.on("finish", () => {
    // Skip noisy/high-volume or binary routes — file streams and the SSE
    // progress channel aren't useful (or safe, memory-wise) to log in full.
    if (req.path.includes("/stream") || req.path.includes("/upload-progress") || req.path.includes("/chunk/")) return;
    recordLog({
      time: startTime,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      latencyMs: Date.now() - startTime,
      ip,
      country: countryForIp(ip),
      requestBody: req.method !== "GET" ? truncateBody(sanitizeForLog(req.body)) : null,
      responseBody: truncateBody(capturedBody),
    });
  });

  next();
});
setInterval(() => { RequestStats.flush().catch(() => {}); }, 15 * 1000).unref();

// Never log sensitive fields even in truncated previews (passwords, codes,
// session-bearing tokens) — the whole point of masking phone numbers and
// hiding sessions in the admin panel is defeated if a raw request body log
// leaks them right back out.
function sanitizeForLog(body) {
  if (!body || typeof body !== "object") return body;
  const clone = { ...body };
  for (const key of ["password", "code", "api_key", "apiKey", "encrypted_session", "sessionString"]) {
    if (key in clone) clone[key] = "***redacted***";
  }
  return clone;
}

// In-memory storage: the file buffer goes straight from the browser's
// upload into Telegram's upload, with no intermediate disk write+read. That
// disk round trip was real, measurable overhead on top of the network
// transfer itself, and removing it is the single biggest upload-speed win
// available without changing the underlying Telegram transfer protocol.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
  next();
}

function getUser(userId) {
  return Users.findById(userId);
}

async function clientForUser(userId) {
  const user = getUser(userId);
  if (!user) throw new Error("User not found");
  const sessionString = decryptSession(user.encrypted_session);
  return getPooledClient(userId, sessionString);
}

// ---------------------------------------------------------------------------
// Real-time upload progress via Server-Sent Events (the server->Telegram leg,
// the real bottleneck — see docs).
// ---------------------------------------------------------------------------
const progressSubscribers = new Map(); // uploadId -> Set<res>
const cancelledUploads = new Set(); // uploadId currently being cancelled

function publishProgress(uploadId, payload) {
  const subs = progressSubscribers.get(uploadId);
  if (!subs) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of subs) res.write(line);
}

app.get("/files/upload-progress/:uploadId", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const { uploadId } = req.params;
  if (!progressSubscribers.has(uploadId)) progressSubscribers.set(uploadId, new Set());
  progressSubscribers.get(uploadId).add(res);

  req.on("close", () => {
    progressSubscribers.get(uploadId)?.delete(res);
  });
});

// Best-effort cancel: if the upload is still in the browser->server leg, the
// browser aborting its own XHR is enough. If it's already in the
// server->Telegram leg, we mark it cancelled and force-disconnect that
// user's pooled Telegram client, which throws inside the in-flight
// sendFile() call and stops the transfer (the pool reconnects fresh next time).
app.post("/files/upload-cancel/:uploadId", requireAuth, async (req, res) => {
  cancelledUploads.add(req.params.uploadId);
  try {
    const user = getUser(req.session.userId);
    if (user) {
      const sessionString = decryptSession(user.encrypted_session);
      const client = await getPooledClient(req.session.userId, sessionString);
      await client.disconnect().catch(() => {});
    }
  } catch (_) {}
  publishProgress(req.params.uploadId, { phase: "error", error: "Cancelled by user" });
  progressSubscribers.delete(req.params.uploadId);
  res.json({ ok: true });
});

// ---------- AUTH ----------

app.post("/auth/send-code", authLimiter, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    const requestId = await sendLoginCode(phone);
    res.json({ requestId });
  } catch (err) {
    console.error("[send-code]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/verify-code", authLimiter, async (req, res) => {
  try {
    const { requestId, code, password } = req.body;
    if (!requestId || !code) return res.status(400).json({ error: "requestId and code required" });

    let sessionString, phone;
    try {
      ({ sessionString, phone } = await verifyLoginCode(requestId, code, password));
    } catch (err) {
      if (err.message === "2FA_PASSWORD_REQUIRED") {
        return res.status(401).json({ error: "2FA_PASSWORD_REQUIRED" });
      }
      throw err;
    }

    const encrypted = encryptSession(sessionString);
    const user = await Users.upsert({ id: uuidv4(), phone, encrypted_session: encrypted });

    req.session.userId = user.id;
    res.json({ ok: true });
  } catch (err) {
    console.error("[verify-code]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/auth/me", (req, res) => {
  if (!req.session?.userId) return res.json({ loggedIn: false });
  Users.touchActive(req.session.userId);
  res.json({ loggedIn: true });
});

// ---------- DEVELOPER API KEY (free personal token for the /api/v1/* routes) ----------

app.get("/auth/api-key", requireAuth, (req, res) => {
  const user = getUser(req.session.userId);
  res.json({ apiKey: user?.api_key || null });
});

app.post("/auth/api-key/generate", requireAuth, async (req, res) => {
  const key = generateApiKey();
  await Users.setApiKey(req.session.userId, key);
  res.json({ apiKey: key });
});

// ---------- PROFILE (name + photo, shown after login — no username, by request) ----------

app.get("/auth/profile", requireAuth, async (req, res) => {
  try {
    const client = await clientForUser(req.session.userId);
    const info = await getProfileInfo(client);
    res.json(info);
  } catch (err) {
    console.error("[profile]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/auth/profile-photo", requireAuth, async (req, res) => {
  try {
    const client = await clientForUser(req.session.userId);
    const buffer = await getProfilePhotoBuffer(client);
    if (!buffer) return res.status(404).end();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (err) {
    console.error("[profile-photo]", err);
    res.status(500).end();
  }
});

// ---------- QR CODE LOGIN ----------

app.post("/auth/qr/start", qrLimiter, (req, res) => {
  const requestId = uuidv4();
  startQrLogin(requestId);
  res.json({ requestId });
});

app.get("/auth/qr/poll/:requestId", async (req, res) => {
  const state = getQrLoginState(req.params.requestId);
  if (!state) return res.status(404).json({ error: "Expired or not found. Start over." });

  if (state.status === "success") {
    try {
      const encrypted = encryptSession(state.sessionString);
      const phone = state.phone || `qr-${req.params.requestId}`;
      const user = await Users.upsert({ id: uuidv4(), phone, encrypted_session: encrypted });
      req.session.userId = user.id;
      cleanupQrLogin(req.params.requestId);
      return res.json({ status: "success" });
    } catch (err) {
      cleanupQrLogin(req.params.requestId);
      return res.json({ status: "error", error: err.message });
    }
  }

  if (state.status === "error") {
    const error = state.error;
    cleanupQrLogin(req.params.requestId);
    return res.json({ status: "error", error });
  }

  if (state.status === "password_required") {
    return res.json({ status: "password_required" });
  }

  if (state.latestToken) {
    try {
      const tgUrl = `tg://login?token=${state.latestToken}`;
      const qrDataUrl = await QRCode.toDataURL(tgUrl, { margin: 1, width: 280 });
      return res.json({ status: "waiting", qrDataUrl, expires: state.expires });
    } catch (err) {
      return res.json({ status: "connecting" });
    }
  }

  res.json({ status: "connecting" });
});

app.post("/auth/qr/password/:requestId", (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "password required" });
  submitQrPassword(req.params.requestId, password);
  res.json({ ok: true });
});

// ---------- BACKUP ACCOUNT ----------
// A second, optional Telegram account. When enabled, every upload is
// mirrored there too, purely as a redundant safety copy in case the
// primary account is ever lost/suspended. Sharing and streaming always use
// the PRIMARY account's copy — the backup is never user-facing on its own.

app.post("/auth/backup/send-code", authLimiter, requireAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    const requestId = await sendLoginCode(phone);
    res.json({ requestId });
  } catch (err) {
    console.error("[backup send-code]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/backup/verify-code", authLimiter, requireAuth, async (req, res) => {
  try {
    const { requestId, code, password } = req.body;
    if (!requestId || !code) return res.status(400).json({ error: "requestId and code required" });

    let sessionString, phone;
    try {
      ({ sessionString, phone } = await verifyLoginCode(requestId, code, password));
    } catch (err) {
      if (err.message === "2FA_PASSWORD_REQUIRED") {
        return res.status(401).json({ error: "2FA_PASSWORD_REQUIRED" });
      }
      throw err;
    }

    const user = getUser(req.session.userId);
    if (phone === user.phone) {
      return res.status(400).json({ error: "This is the same account you're already logged in with. Use a different Telegram account for backup." });
    }

    const encrypted = encryptSession(sessionString);
    await Users.setBackupAccount(req.session.userId, { encrypted_session: encrypted, phone });
    res.json({ ok: true, phone });
  } catch (err) {
    console.error("[backup verify-code]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/auth/backup/status", requireAuth, (req, res) => {
  const user = getUser(req.session.userId);
  res.json({
    hasBackup: !!user.backup_encrypted_session,
    backupPhone: user.backup_phone,
    backupEnabled: !!user.backup_enabled,
  });
});

app.post("/auth/backup/toggle", requireAuth, async (req, res) => {
  const user = getUser(req.session.userId);
  if (!user.backup_encrypted_session) return res.status(400).json({ error: "No backup account added yet" });
  const { enabled } = req.body;
  await Users.setBackupEnabled(req.session.userId, !!enabled);
  res.json({ ok: true, backupEnabled: !!enabled });
});

app.post("/auth/backup/remove", requireAuth, async (req, res) => {
  await Users.removeBackupAccount(req.session.userId);
  res.json({ ok: true });
});

// ---------- FOLDERS ----------

app.get("/folders", requireAuth, (req, res) => {
  const parentId = req.query.parent_id || null;
  const folders = Folders.findByUser(req.session.userId, parentId);
  const breadcrumb = parentId ? Folders.breadcrumb(parentId) : [];
  res.json({ folders, breadcrumb });
});

app.post("/folders", requireAuth, async (req, res) => {
  const { name, parent_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Folder name required" });
  const folder = await Folders.create({
    id: uuidv4(),
    user_id: req.session.userId,
    name: name.trim(),
    parent_id: parent_id || null,
  });
  res.json({ folder });
});

app.delete("/folders/:id", requireAuth, async (req, res) => {
  const folder = Folders.findById(req.params.id);
  if (!folder || folder.user_id !== req.session.userId) return res.status(404).json({ error: "not found" });
  const hasFiles = Files.findByUserAndFolder(req.session.userId, folder.id).length > 0;
  const hasSubfolders = Folders.findByUser(req.session.userId, folder.id).length > 0;
  if (hasFiles || hasSubfolders) return res.status(400).json({ error: "Folder is not empty" });
  await Folders.remove(folder.id);
  res.json({ ok: true });
});

// ---------- FILES ----------

app.post("/files/upload", requireAuth, upload.single("file"), async (req, res) => {
  const uploadId = req.query.uploadId;
  let aborted = false;
  req.on("aborted", () => { aborted = true; cancelledUploads.add(uploadId); });

  try {
    if (!req.file) return res.status(400).json({ error: "No file received" });

    const client = await clientForUser(req.session.userId);
    const totalSize = req.file.size;

    // Resolve/auto-create a nested folder path if this came from a folder upload.
    let folderId = req.body.folder_id || null;
    const relativePath = req.body.relativePath;
    if (relativePath) {
      const parts = relativePath.split("/").filter(Boolean);
      for (const part of parts) {
        const folder = await Folders.getOrCreatePath(req.session.userId, folderId, part);
        folderId = folder.id;
      }
    }

    const uploadStartTime = Date.now();
    let lastTime = uploadStartTime;
    let lastBytes = 0;

    const message = await uploadToSavedMessages(client, req.file.buffer, req.file.originalname, totalSize, (fraction) => {
      if (cancelledUploads.has(uploadId)) throw new Error("Upload cancelled");
      if (!uploadId) return;
      const now = Date.now();
      const bytes = Math.round(fraction * totalSize);
      const dt = (now - lastTime) / 1000;
      const dBytes = bytes - lastBytes;
      const elapsedTotal = (now - uploadStartTime) / 1000;
      // Instantaneous speed once enough time has passed between callbacks;
      // otherwise fall back to the average since the transfer started, so
      // small/fast files still show a real number instead of staying at 0
      // until (if ever) a large-enough delta accumulates.
      const speed = dt >= 0.15 ? dBytes / dt : (elapsedTotal > 0.05 ? bytes / elapsedTotal : 0);
      if (dt >= 0.15) { lastTime = now; lastBytes = bytes; }
      publishProgress(uploadId, { phase: "telegram", bytes, total: totalSize, pct: Math.round(fraction * 100), speed });
    });

    cancelledUploads.delete(uploadId);
    if (uploadId) {
      publishProgress(uploadId, { phase: "done", bytes: totalSize, total: totalSize, pct: 100, speed: 0 });
      progressSubscribers.delete(uploadId);
    }

    // Mirror to the backup account, if the user has one added and enabled.
    // Best-effort — never blocks or fails the response, since the primary
    // copy (what the user actually sees in the Library) already succeeded.
    const user = getUser(req.session.userId);
    const backupMessageId = await backupUploadBestEffort(user, req.file.buffer, req.file.originalname, totalSize);

    const id = uuidv4();
    await Files.create({
      id,
      user_id: req.session.userId,
      tg_message_id: message.id,
      filename: req.file.originalname,
      mimetype: req.file.mimetype || "application/octet-stream",
      size: req.file.size,
      folder_id: folderId,
      backup_tg_message_id: backupMessageId,
    });

    if (!aborted) res.json({ id, filename: req.file.originalname });
  } catch (err) {
    console.error("[upload]", err);
    cancelledUploads.delete(uploadId);

    let userMessage = err.message || "Upload failed";
    if (isAuthError(err)) {
      // The stored Telegram session is no longer valid (e.g. the session
      // was terminated from Telegram's "Devices" settings, or the account
      // was logged out elsewhere). Reusing the same dead connection would
      // just keep failing the same way on every retry, so drop it from the
      // pool — the next login will establish a fresh, valid one.
      evictPooledClient(req.session.userId);
      userMessage = "Your Telegram session is no longer valid (it may have been logged out from another device). Please log out and log back in to continue.";
    }

    if (uploadId) publishProgress(uploadId, { phase: "error", error: userMessage });
    if (!aborted && !res.headersSent) res.status(500).json({ error: userMessage });
  }
});

// ---------------------------------------------------------------------------
// Resumable chunked upload.
//
// The web app uploads files in small chunks instead of one big request, so
// that if the user's internet drops mid-upload, only the ONE in-flight
// chunk needs to be retried — not the whole file. The server tracks how
// many bytes it has received per session; the client asks for that number
// on reconnect and simply keeps going from there. Nothing is lost, nothing
// is cancelled, and the upload doesn't error out for a transient network
// blip — it just quietly resumes at the same point once connectivity is
// back, at whatever speed the connection currently allows.
// ---------------------------------------------------------------------------

const CHUNK_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — generous, since "paused waiting for internet" could genuinely take a while
const chunkSessions = new Map(); // sessionId -> { userId, tempPath, receivedBytes, totalSize, filename, mimetype, folderId, relativePath, createdAt, lastActivity }

function chunkTempPath(sessionId) {
  return path.join(os.tmpdir(), `tc-chunked-${sessionId}`);
}

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of chunkSessions.entries()) {
    if (now - session.lastActivity > CHUNK_SESSION_TTL_MS) {
      fs.unlink(session.tempPath).catch(() => {});
      chunkSessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000).unref();

app.post("/files/upload/init", requireAuth, async (req, res) => {
  try {
    const { filename, fileSize, mimetype, folder_id, relativePath } = req.body;
    if (!filename || !fileSize) return res.status(400).json({ error: "filename and fileSize required" });

    const sessionId = uuidv4();
    const tempPath = chunkTempPath(sessionId);
    await fs.writeFile(tempPath, Buffer.alloc(0)); // create empty file to append to

    chunkSessions.set(sessionId, {
      userId: req.session.userId,
      tempPath,
      receivedBytes: 0,
      totalSize: fileSize,
      filename,
      mimetype: mimetype || "application/octet-stream",
      folderId: folder_id || null,
      relativePath: relativePath || null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });

    // 4MB chunks: small enough that a dropped connection only costs a few
    // seconds of redo, large enough not to drown in per-request overhead.
    res.json({ sessionId, chunkSize: 4 * 1024 * 1024 });
  } catch (err) {
    console.error("[upload/init]", err);
    res.status(500).json({ error: err.message });
  }
});

// Raw binary body for chunk data — kept separate from the global express.json()
// parser, and capped a little above the chunk size to reject anything abusive.
const chunkBodyParser = express.raw({ type: "application/octet-stream", limit: "6mb" });

app.post("/files/upload/chunk/:sessionId", requireAuth, chunkBodyParser, async (req, res) => {
  try {
    const session = chunkSessions.get(req.params.sessionId);
    if (!session || session.userId !== req.session.userId) {
      return res.status(404).json({ error: "Upload session not found or expired. Please restart the upload." });
    }
    const offset = parseInt(req.query.offset, 10);
    if (Number.isNaN(offset)) return res.status(400).json({ error: "offset query param required" });

    // Client and server must agree on exactly where this chunk starts. If
    // they don't (e.g. the client's last "success" never actually reached
    // us before the connection dropped), tell it the real received count so
    // it can realign and resend from the correct point — this IS the resume
    // mechanism, no separate negotiation step needed.
    if (offset !== session.receivedBytes) {
      return res.status(409).json({ error: "Offset mismatch", expectedOffset: session.receivedBytes });
    }

    const chunk = req.body; // Buffer, thanks to express.raw()
    await fs.appendFile(session.tempPath, chunk);
    session.receivedBytes += chunk.length;
    session.lastActivity = Date.now();

    res.json({ ok: true, receivedBytes: session.receivedBytes });
  } catch (err) {
    console.error("[upload/chunk]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/files/upload/status/:sessionId", requireAuth, (req, res) => {
  const session = chunkSessions.get(req.params.sessionId);
  if (!session || session.userId !== req.session.userId) {
    return res.status(404).json({ error: "Upload session not found or expired." });
  }
  res.json({ receivedBytes: session.receivedBytes, totalSize: session.totalSize });
});

app.post("/files/upload/abort/:sessionId", requireAuth, async (req, res) => {
  const session = chunkSessions.get(req.params.sessionId);
  if (session && session.userId === req.session.userId) {
    fs.unlink(session.tempPath).catch(() => {});
    chunkSessions.delete(req.params.sessionId);
  }
  res.json({ ok: true });
});

app.post("/files/upload/complete/:sessionId", requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const session = chunkSessions.get(sessionId);
  if (!session || session.userId !== req.session.userId) {
    return res.status(404).json({ error: "Upload session not found or expired. Please restart the upload." });
  }
  if (session.receivedBytes !== session.totalSize) {
    return res.status(400).json({ error: "Not all chunks have been received yet", receivedBytes: session.receivedBytes, totalSize: session.totalSize });
  }

  try {
    const client = await clientForUser(req.session.userId);

    let folderId = session.folderId;
    if (session.relativePath) {
      const parts = session.relativePath.split("/").filter(Boolean);
      for (const part of parts) {
        const folder = await Folders.getOrCreatePath(req.session.userId, folderId, part);
        folderId = folder.id;
      }
    }

    const uploadStartTime = Date.now();
    let lastTime = uploadStartTime;
    let lastBytes = 0;

    const message = await uploadToSavedMessages(client, session.tempPath, session.filename, session.totalSize, (fraction) => {
      const now = Date.now();
      const bytes = Math.round(fraction * session.totalSize);
      const dt = (now - lastTime) / 1000;
      const dBytes = bytes - lastBytes;
      const elapsedTotal = (now - uploadStartTime) / 1000;
      const speed = dt >= 0.15 ? dBytes / dt : (elapsedTotal > 0.05 ? bytes / elapsedTotal : 0);
      if (dt >= 0.15) { lastTime = now; lastBytes = bytes; }
      publishProgress(sessionId, { phase: "telegram", bytes, total: session.totalSize, pct: Math.round(fraction * 100), speed });
    });

    publishProgress(sessionId, { phase: "done", bytes: session.totalSize, total: session.totalSize, pct: 100, speed: 0 });
    progressSubscribers.delete(sessionId);

    const user = getUser(req.session.userId);
    const backupMessageId = await backupUploadBestEffort(user, session.tempPath, session.filename, session.totalSize);

    const id = uuidv4();
    await Files.create({
      id,
      user_id: req.session.userId,
      tg_message_id: message.id,
      filename: session.filename,
      mimetype: session.mimetype,
      size: session.totalSize,
      folder_id: folderId,
      backup_tg_message_id: backupMessageId,
    });

    res.json({ id, filename: session.filename });
  } catch (err) {
    console.error("[upload/complete]", err);
    let userMessage = err.message || "Upload failed";
    if (isAuthError(err)) {
      evictPooledClient(req.session.userId);
      userMessage = "Your Telegram session is no longer valid (it may have been logged out from another device). Please log out and log back in to continue.";
    }
    publishProgress(sessionId, { phase: "error", error: userMessage });
    res.status(500).json({ error: userMessage });
  } finally {
    fs.unlink(session.tempPath).catch(() => {});
    chunkSessions.delete(sessionId);
  }
});

app.get("/files", requireAuth, (req, res) => {
  const files = req.query.all === "1"
    ? Files.findByUser(req.session.userId)
    : Files.findByUserAndFolder(req.session.userId, req.query.folder_id || null);
  res.json({
    files: files.map(({ id, filename, mimetype, size, visibility, share_token, folder_id, created_at }) => ({
      id, filename, mimetype, size, visibility, share_token, folder_id, created_at,
    })),
  });
});

app.delete("/files/:id", requireAuth, async (req, res) => {
  const file = Files.findByIdAndUser(req.params.id, req.session.userId);
  if (!file) return res.status(404).json({ error: "not found" });
  await Files.remove(file.id);
  res.json({ ok: true });
});

app.patch("/files/:id", requireAuth, async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename || !filename.trim()) return res.status(400).json({ error: "filename required" });
    const file = Files.findByIdAndUser(req.params.id, req.session.userId);
    if (!file) return res.status(404).json({ error: "not found" });

    const client = await clientForUser(req.session.userId);
    const message = await findSavedMessage(client, file.tg_message_id);
    if (message) {
      // Keep the Telegram message caption in sync too, not just our DB.
      await renameSavedMessage(client, message, filename.trim()).catch((e) => {
        console.error("[rename] failed to update Telegram caption", e);
      });
    }

    await Files.update(file.id, { filename: filename.trim() });
    res.json({ ok: true, filename: filename.trim() });
  } catch (err) {
    console.error("[rename]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/files/:id/share", requireAuth, async (req, res) => {
  try {
    const { visibility } = req.body;
    const file = Files.findByIdAndUser(req.params.id, req.session.userId);
    if (!file) return res.status(404).json({ error: "not found" });

    let token = file.share_token;
    if (visibility === "public" && !token) token = uuidv4();

    await Files.update(file.id, { visibility, share_token: visibility === "public" ? token : file.share_token });

    const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
    res.json({ visibility, shareUrl: visibility === "public" ? `${base}/public/${token}` : null });
  } catch (err) {
    console.error("[share]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/files/:id/stream", requireAuth, async (req, res) => {
  const file = Files.findByIdAndUser(req.params.id, req.session.userId);
  if (!file) return res.status(404).json({ error: "File not found" });
  await streamFileToResponse(file, req, res, req.query.download === "1");
});

app.get("/public/:token/info", (req, res) => {
  const file = Files.findByShareToken(req.params.token);
  if (!file) return res.status(404).json({ error: "not found" });
  res.json({ filename: file.filename, size: file.size, mimetype: file.mimetype });
});

app.get("/public/:token", async (req, res) => {
  const file = Files.findByShareToken(req.params.token);
  if (!file) return res.status(404).json({ error: "File not found or is private" });
  await streamFileToResponse(file, req, res, req.query.download === "1");
});

async function streamFileToResponse(file, req, res, forceDownload) {
  try {
    const client = await clientForUser(file.user_id);
    const message = await findSavedMessage(client, file.tg_message_id);

    if (!message || !message.media) {
      console.error("[stream] message/media not found for file", file.id, "tg_message_id", file.tg_message_id);
      return res.status(404).json({ error: "File content not found on Telegram (was it deleted from Saved Messages?)" });
    }

    const size = file.size;
    const range = req.headers.range;

    res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    const disposition = forceDownload ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(file.filename)}"`);

    let start = 0;
    let end = size - 1;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        start = parseInt(match[1], 10);
        end = match[2] ? parseInt(match[2], 10) : size - 1;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    } else {
      res.status(200);
    }
    res.setHeader("Content-Length", end - start + 1);

    try {
      for await (const chunk of iterDownloadRange(client, message, start, end - start + 1)) {
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } catch (streamErr) {
      console.error("[stream] error while writing chunks", streamErr);
      if (!res.headersSent) res.status(500).json({ error: streamErr.message });
      else res.end();
    }
  } catch (err) {
    console.error("[stream] fatal error", err);
    let userMessage = err.message || "Streaming failed";
    if (isAuthError(err)) {
      evictPooledClient(file.user_id);
      userMessage = "This account's Telegram session is no longer valid. The owner needs to log out and log back in.";
    }
    if (!res.headersSent) res.status(500).json({ error: userMessage });
  }
}

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- DEVELOPER API (API-key based, for external projects) ----------
app.use("/api", apiLimiter, apiRouter);

// ---------- ADMIN (metadata monitoring only — see admin.js) ----------
app.use("/admin", adminRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`tg-drive backend listening on :${PORT}`);
  console.log(`NODE_ENV=${process.env.NODE_ENV || "(not set)"}`);
  console.log(`FRONTEND_URL=${process.env.FRONTEND_URL || "(not set — CORS will fall back to permissive, cookies will NOT work cross-domain)"}`);
  console.log(`Cookie settings: sameSite=${isProd ? "none" : "lax"}, secure=${isProd}`);
});
