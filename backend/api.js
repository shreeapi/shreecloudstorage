import express from "express";
import multer from "multer";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Users, Files } from "./db.js";
import { decryptSession, getPooledClient, uploadToSavedMessages, findSavedMessage, backupUploadBestEffort, isAuthError, evictPooledClient } from "./telegramClient.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// Every logged-in web user can generate a personal API key (see /auth routes
// in server.js) and use it to call this API directly from their own
// projects — no OAuth dance, just a header. Free to use, same underlying
// Telegram-backed storage as the website.
// ---------------------------------------------------------------------------

export function generateApiKey() {
  return "tc_" + crypto.randomBytes(24).toString("hex");
}

function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key") || (req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!key) return res.status(401).json({ error: "Missing API key. Send it as 'X-API-Key' header." });
  const user = Users.findByApiKey(key);
  if (!user) return res.status(401).json({ error: "Invalid API key" });
  req.apiUser = user;
  next();
}

async function clientFor(user) {
  const sessionString = decryptSession(user.encrypted_session);
  return getPooledClient(user.id, sessionString);
}

/**
 * POST /api/v1/upload
 * Headers: X-API-Key: <key>
 * Body: multipart/form-data, field "file"
 * Query: ?public=0 to keep the file private (default is a working public
 *   share link right away — that's the whole point of uploading via the
 *   API: you get back a URL that already works, no extra step on the
 *   website needed).
 */
router.post("/v1/upload", requireApiKey, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file received (expected multipart field 'file')" });

    const client = await clientFor(req.apiUser);
    const message = await uploadToSavedMessages(client, req.file.buffer, req.file.originalname, req.file.size, () => {});

    // Mirror to the backup account, if the user has one added and enabled —
    // same best-effort behavior as web uploads.
    const backupMessageId = await backupUploadBestEffort(req.apiUser, req.file.buffer, req.file.originalname, req.file.size);

    const id = uuidv4();
    const isPublic = req.query.public !== "0";
    const visibility = isPublic ? "public" : "private";
    const share_token = isPublic ? uuidv4() : null;

    await Files.create({
      id,
      user_id: req.apiUser.id,
      tg_message_id: message.id,
      filename: req.file.originalname,
      mimetype: req.file.mimetype || "application/octet-stream",
      size: req.file.size,
      visibility,
      share_token,
      backup_tg_message_id: backupMessageId,
    });

    const base = process.env.PUBLIC_BASE_URL_API || process.env.API_PUBLIC_URL || "";
    res.json({
      id,
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      streamUrl: `${base}/api/v1/files/${id}/stream`,
      shareUrl: isPublic ? `${(process.env.PUBLIC_BASE_URL || "")}/public/${share_token}` : null,
    });
  } catch (err) {
    console.error("[api/upload]", err);
    let userMessage = err.message || "Upload failed";
    if (isAuthError(err)) {
      evictPooledClient(req.apiUser.id);
      userMessage = "Your Telegram session is no longer valid (it may have been logged out from another device). Log back in on the website to refresh it.";
    }
    res.status(500).json({ error: userMessage });
  }
});

/** GET /api/v1/files — list your files */
router.get("/v1/files", requireApiKey, (req, res) => {
  const files = Files.findByUser(req.apiUser.id).map(
    ({ id, filename, mimetype, size, visibility, share_token, folder_id, created_at }) => ({
      id, filename, mimetype, size, visibility, share_token, folder_id, created_at,
    })
  );
  res.json({ files });
});

/** GET /api/v1/files/:id — metadata for one file */
router.get("/v1/files/:id", requireApiKey, (req, res) => {
  const file = Files.findByIdAndUser(req.params.id, req.apiUser.id);
  if (!file) return res.status(404).json({ error: "not found" });
  res.json({ file });
});

/** DELETE /api/v1/files/:id */
router.delete("/v1/files/:id", requireApiKey, async (req, res) => {
  const file = Files.findByIdAndUser(req.params.id, req.apiUser.id);
  if (!file) return res.status(404).json({ error: "not found" });
  await Files.remove(file.id);
  res.json({ ok: true });
});

/** GET /api/v1/files/:id/stream — download/stream with Range support */
router.get("/v1/files/:id/stream", requireApiKey, async (req, res) => {
  const file = Files.findByIdAndUser(req.params.id, req.apiUser.id);
  if (!file) return res.status(404).json({ error: "not found" });
  try {
    const client = await clientFor(req.apiUser);
    const message = await findSavedMessage(client, file.tg_message_id);
    if (!message || !message.media) return res.status(404).json({ error: "File content not found on Telegram" });

    const { iterDownloadRange } = await import("./telegramClient.js");
    const size = file.size;
    const range = req.headers.range;
    res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.filename)}"`);

    let start = 0, end = size - 1;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        start = parseInt(match[1], 10);
        end = match[2] ? parseInt(match[2], 10) : size - 1;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    res.setHeader("Content-Length", end - start + 1);
    for await (const chunk of iterDownloadRange(client, message, start, end - start + 1)) {
      if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
    }
    res.end();
  } catch (err) {
    console.error("[api/stream]", err);
    let userMessage = err.message || "Streaming failed";
    if (isAuthError(err)) {
      evictPooledClient(req.apiUser.id);
      userMessage = "Your Telegram session is no longer valid (it may have been logged out from another device). Log back in on the website to refresh it.";
    }
    if (!res.headersSent) res.status(500).json({ error: userMessage });
  }
});

export default router;
