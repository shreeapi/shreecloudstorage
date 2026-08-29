import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import CryptoJS from "crypto-js";
import bigInt from "big-integer";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import "dotenv/config";

const apiId = parseInt(process.env.TG_API_ID, 10);
const apiHash = process.env.TG_API_HASH;
const ENC_KEY = process.env.SESSION_ENCRYPT_KEY;

if (!ENC_KEY) {
  throw new Error(
    "Missing SESSION_ENCRYPT_KEY environment variable. Set it in your .env " +
    "(or Railway Variables) to a long random string — without it, session " +
    "encryption will crash with a confusing crypto-js error the moment " +
    "someone logs in."
  );
}

export function encryptSession(sessionString) {
  return CryptoJS.AES.encrypt(sessionString, ENC_KEY).toString();
}

export function decryptSession(encrypted) {
  const bytes = CryptoJS.AES.decrypt(encrypted, ENC_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// In-memory map for in-progress logins (phone code hash + temp client), keyed by requestId
const pendingLogins = new Map();

/**
 * Step 1 of login: send the Telegram login code to the user's phone.
 * Returns a requestId the frontend must send back with the code.
 */
export async function sendLoginCode(phone) {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  const result = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber: phone,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({}),
    })
  );

  const requestId = `${phone}-${Date.now()}`;
  pendingLogins.set(requestId, {
    client,
    phone,
    phoneCodeHash: result.phoneCodeHash,
    createdAt: Date.now(),
  });

  return requestId;
}

/**
 * Step 2 of login: verify the code (and 2FA password if needed).
 * Returns a session string to persist (encrypted) for this user.
 */
export async function verifyLoginCode(requestId, code, password) {
  const pending = pendingLogins.get(requestId);
  if (!pending) throw new Error("Login request expired or not found. Start over.");

  const { client, phone, phoneCodeHash } = pending;

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (err) {
    // 2FA enabled accounts throw SESSION_PASSWORD_NEEDED
    if (err.errorMessage === "SESSION_PASSWORD_NEEDED" || /PASSWORD_NEEDED/i.test(String(err))) {
      if (!password) {
        throw new Error("2FA_PASSWORD_REQUIRED");
      }
      await client.signInWithPassword(
        { apiId, apiHash },
        {
          password: async () => password,
          onError: (e) => { throw e; },
        }
      );
    } else {
      throw err;
    }
  }

  const sessionString = client.session.save();
  pendingLogins.delete(requestId);
  // NOTE: intentionally not disconnecting here — the pool below will reuse
  // this same client for this user immediately after login.

  return { sessionString, phone, client };
}

// ---------------------------------------------------------------------------
// Connection pool: reuse one connected GramJS client per user instead of
// reconnecting on every single request. Reconnecting per-request was slow
// and could silently time out, which is what caused streaming to appear to
// "hang" and return a blank page.
// ---------------------------------------------------------------------------
const clientPool = new Map(); // userId -> { client, lastUsed }
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export async function getPooledClient(userId, sessionString) {
  const existing = clientPool.get(userId);
  if (existing && existing.client.connected) {
    existing.lastUsed = Date.now();
    return existing.client;
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  clientPool.set(userId, { client, lastUsed: Date.now() });
  return client;
}

/**
 * True if an error means the Telegram session itself is dead — revoked,
 * logged out elsewhere, or otherwise no longer authorized. This is NOT a
 * transient network issue; reusing the same pooled connection will just
 * keep failing the same way, and the only real fix is logging in again.
 */
export function isAuthError(err) {
  const msg = String(err?.message || err || "");
  return /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|USER_DEACTIVATED/i.test(msg);
}

/**
 * Drop a pooled connection immediately (e.g. after an auth error) so the
 * next request reconnects fresh instead of silently reusing a dead session.
 */
export function evictPooledClient(userId) {
  const entry = clientPool.get(userId);
  if (entry) {
    entry.client.disconnect().catch(() => {});
    clientPool.delete(userId);
  }
}

// Periodically close idle connections so we don't leak sockets.
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of clientPool.entries()) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      entry.client.disconnect().catch(() => {});
      clientPool.delete(userId);
    }
  }
}, 60 * 1000).unref();

/**
 * Get a one-off connected GramJS client (used only for the login flow).
 */
export async function getClientForSession(sessionString) {
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  return client;
}

/**
 * Upload a file to the user's own Saved Messages.
 *
 * Accepts either a disk path (string) or an in-memory Buffer.
 *
 * Important GramJS constraint (not something we can configure around):
 * internally, for any file over ~20MB, GramJS insists on reading from a real
 * file path on disk in chunks — it will NOT accept an in-memory buffer for
 * large files, even wrapped in CustomFile, and throws "Either one of
 * `buffer` or `filePath` should be specified" if given one anyway. So:
 *   - Files <= 20MB: uploaded straight from memory, no disk I/O at all.
 *   - Files  > 20MB: written to a temp file once (unavoidable — this is a
 *     GramJS-side requirement, not something we're choosing), then cleaned
 *     up immediately after the upload completes.
 * `workers: 16` uploads 16 file parts to Telegram in parallel either way.
 */
const LARGE_FILE_THRESHOLD = 20 * 1024 * 1024 - 1;

export async function uploadToSavedMessages(client, fileInput, fileName, fileSize, onProgress) {
  let file;
  let tempPath = null;

  if (typeof fileInput === "string") {
    file = fileInput; // legacy disk-path support
  } else if (fileSize > LARGE_FILE_THRESHOLD) {
    tempPath = path.join(os.tmpdir(), `tcupload-${crypto.randomBytes(8).toString("hex")}`);
    await fs.writeFile(tempPath, fileInput);
    file = new CustomFile(fileName, fileSize, tempPath);
  } else {
    file = new CustomFile(fileName, fileSize, "", fileInput); // stays fully in memory
  }

  try {
    const result = await client.sendFile("me", {
      file,
      caption: fileName,
      workers: 16,
      progressCallback: (progress) => {
        if (onProgress) onProgress(progress);
      },
    });
    return result; // Api.Message
  } finally {
    if (tempPath) {
      fs.unlink(tempPath).catch(() => {});
    }
  }
}

/**
 * Look up a message by id in Saved Messages, with a fallback search in case
 * a direct id lookup returns nothing (this happened when the id lookup was
 * silently failing and callers were treating it as a 404).
 */
/**
 * Rename a file on both sides: this edits the caption of the real Telegram
 * message (so it stays in sync if the user looks at Saved Messages directly),
 * the caller is responsible for updating the filename in our own DB too.
 */
export async function renameSavedMessage(client, message, newName) {
  await client.invoke(
    new Api.messages.EditMessage({
      peer: "me",
      id: message.id,
      message: newName,
    })
  );
}

// ---------------------------------------------------------------------------
// QR code login — lets a user scan a code with their phone's Telegram app
// instead of typing a code manually. Runs in the background per requestId;
// the frontend polls getQrLoginState() until it reaches 'success'/'error'.
// ---------------------------------------------------------------------------
const pendingQrLogins = new Map();

function toBase64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function startQrLogin(requestId) {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
  const state = { client, status: "connecting", latestToken: null, expires: null, error: null, sessionString: null, phone: null, createdAt: Date.now() };
  pendingQrLogins.set(requestId, state);

  (async () => {
    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out connecting to Telegram. Please try again.")), 20000)),
      ]);
      state.status = "waiting";
      const user = await client.signInUserWithQrCode(
        { apiId, apiHash },
        {
          qrCode: async ({ token, expires }) => {
            state.latestToken = toBase64Url(token);
            state.expires = expires;
          },
          onError: async (err) => {
            state.status = "error";
            state.error = err.message || String(err);
          },
          password: async () => {
            state.status = "password_required";
            return new Promise((resolve) => {
              state.passwordResolve = resolve;
            });
          },
        }
      );
      state.status = "success";
      state.sessionString = client.session.save();
      state.phone = user?.phone ? `+${user.phone}` : null;
    } catch (err) {
      if (state.status !== "error") {
        state.status = "error";
        state.error = err.message || String(err);
      }
    }
  })();

  return state;
}

export function getQrLoginState(requestId) {
  return pendingQrLogins.get(requestId);
}

export function submitQrPassword(requestId, password) {
  const state = pendingQrLogins.get(requestId);
  if (state?.passwordResolve) {
    state.passwordResolve(password);
    state.passwordResolve = null;
  }
}

export function cleanupQrLogin(requestId) {
  const state = pendingQrLogins.get(requestId);
  pendingQrLogins.delete(requestId);
  return state;
}

// ---------------------------------------------------------------------------
// Telegram profile info — shown after login, mirroring the "name + photo"
// feel of the real Telegram app (no username shown, by request).
// ---------------------------------------------------------------------------
export async function getProfileInfo(client) {
  const me = await client.getMe();
  return {
    firstName: me.firstName || "",
    lastName: me.lastName || "",
    phone: me.phone ? `+${me.phone}` : null,
  };
}

export async function getProfilePhotoBuffer(client) {
  const me = await client.getMe();
  const buffer = await client.downloadProfilePhoto(me, { isBig: false });
  return buffer && buffer.length ? buffer : null;
}

export async function findSavedMessage(client, messageId) {
  const me = await client.getEntity("me");
  let messages = await client.getMessages(me, { ids: [messageId] });
  let message = messages?.[0];
  if (message && message.className !== "MessageEmpty") return message;

  // Fallback: scan recent saved messages for a matching id.
  for await (const m of client.iterMessages(me, { limit: 200 })) {
    if (m.id === messageId) return m;
  }
  return null;
}

/**
 * Stream a range of bytes for a given message's media back to the caller.
 * offset/limit are in bytes. Uses GramJS's downloadMedia in chunks.
 */
export async function* iterDownloadRange(client, message, offset, byteLength) {
  // GramJS's MAX_CHUNK_SIZE is exactly 512KB. If requestSize is set any
  // higher, GramJS silently clamps requestSize but NOT chunkSize, which
  // makes them mismatch and forces it onto the "GenericDownloadIter" code
  // path — which has a bug (`this.request.offset.mod is not a function`)
  // when offset isn't perfectly chunk-aligned. Keeping requestSize exactly
  // at 512KB keeps chunkSize === requestSize, which uses the working
  // "DirectDownloadIter" path instead.
  const CHUNK = 512 * 1024;
  const iter = client.iterDownload({
    file: message.media,
    offset: bigInt(offset),
    // fileSize (not "limit") is how GramJS computes how many chunks to
    // fetch — it must be a big-integer instance too.
    fileSize: bigInt(byteLength),
    requestSize: CHUNK,
  });
  for await (const chunk of iter) {
    yield chunk;
  }
}

// ---------------------------------------------------------------------------
// Cleanup sweep for abandoned login attempts.
//
// If someone opens the login page (phone-code or QR) and then just closes
// the tab without finishing, the Telegram connection we opened for that
// attempt was being left open FOREVER. Over time, enough abandoned attempts
// pile up that the server runs low on memory/connections and starts
// failing requests intermittently for everyone — which matches "works for
// some people, not others" reports exactly.
//
// This does NOT touch any completed/successful login or any existing user's
// data — it only closes connections for attempts that never finished within
// a few minutes.
const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  const now = Date.now();

  for (const [requestId, pending] of pendingLogins.entries()) {
    if (now - (pending.createdAt || 0) > PENDING_LOGIN_TTL_MS) {
      pending.client?.disconnect().catch(() => {});
      pendingLogins.delete(requestId);
    }
  }

  for (const [requestId, state] of pendingQrLogins.entries()) {
    // Only sweep up genuinely abandoned attempts (still in-progress after
    // the TTL). 'success'/'error' states are intentionally left alone here
    // — they're cleaned up explicitly once the frontend's poll has actually
    // consumed the result (see /auth/qr/poll in server.js). Deleting them
    // proactively here could race against a poll that hasn't landed yet
    // and turn a successful login into a false "expired" error.
    if (now - (state.createdAt || 0) > PENDING_LOGIN_TTL_MS) {
      state.client?.disconnect().catch(() => {});
      pendingQrLogins.delete(requestId);
    }
  }
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Backup account — best-effort mirror upload.
//
// Shared by both server.js (web uploads) and api.js (developer API uploads)
// so the logic lives in exactly one place. Lives here rather than in
// server.js specifically to avoid a circular import (server.js already
// imports api.js, and api.js would need this too).
// ---------------------------------------------------------------------------

export async function clientForBackup(user) {
  if (!user.backup_encrypted_session) return null;
  const sessionString = decryptSession(user.backup_encrypted_session);
  // Distinct pool key so the backup connection never collides with the
  // user's primary one.
  return getPooledClient(`${user.id}:backup`, sessionString);
}

/**
 * Best-effort mirror of an upload to the user's backup account, if they
 * have one added and enabled. Never throws — a backup failure must not
 * fail the primary upload, since the primary copy already succeeded and
 * that's what the user is actually waiting on. Returns the backup
 * message id (or null) so callers can optionally store it.
 */
export async function backupUploadBestEffort(user, buffer, filename, size) {
  if (!user.backup_enabled || !user.backup_encrypted_session) return null;
  try {
    const backupClient = await clientForBackup(user);
    if (!backupClient) return null;
    const message = await uploadToSavedMessages(backupClient, buffer, filename, size, () => {});
    return message.id;
  } catch (err) {
    if (isAuthError(err)) {
      evictPooledClient(`${user.id}:backup`);
      console.error(`[backup-upload] backup account's session is no longer valid (${err.message}) — user needs to re-add their backup account. Primary upload is unaffected.`);
    } else {
      console.error("[backup-upload] failed, primary upload is unaffected:", err.message);
    }
    return null;
  }
}
