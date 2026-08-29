import { JSONFilePreset } from "lowdb/node";

const defaultData = {
  users: [], files: [], folders: [],
  bannedIps: [], // [{ ip, bannedAt, reason }]
  requestStats: { totalRequests: 0, dailyCounts: {}, ipStats: {} }, // ipStats: { [ip]: { count, firstSeen, lastSeen } }
};
const db = await JSONFilePreset("tgdrive.json", defaultData);

// Backfill fields for databases that existed before this update.
db.data.bannedIps ||= [];
db.data.requestStats ||= { totalRequests: 0, dailyCounts: {}, ipStats: {} };
db.data.requestStats.dailyCounts ||= {};
db.data.requestStats.ipStats ||= {};
await db.write();

function now() { return Date.now(); }

export const Users = {
  findByPhone(phone) { return db.data.users.find((u) => u.phone === phone); },
  findById(id) { return db.data.users.find((u) => u.id === id); },
  findByApiKey(key) { return db.data.users.find((u) => u.api_key === key); },
  all() { return db.data.users; },
  async upsert({ id, phone, encrypted_session }) {
    let user = this.findByPhone(phone);
    if (user) {
      user.encrypted_session = encrypted_session;
      user.last_login = now();
    } else {
      user = {
        id, phone, encrypted_session, created_at: now(), last_login: now(), last_active: now(), api_key: null,
        // Backup account — an optional second Telegram account. When
        // backup_enabled is true, every upload also goes to this account's
        // Saved Messages, purely as a redundant copy. Sharing/streaming
        // always uses the PRIMARY account's copy, never the backup's.
        backup_encrypted_session: null,
        backup_phone: null,
        backup_enabled: false,
      };
      db.data.users.push(user);
    }
    await db.write();
    return user;
  },
  async touchActive(id) {
    const user = this.findById(id);
    if (user) { user.last_active = now(); await db.write(); }
  },
  async setApiKey(id, key) {
    const user = this.findById(id);
    if (!user) return null;
    user.api_key = key;
    await db.write();
    return user;
  },
  async setBackupAccount(id, { encrypted_session, phone }) {
    const user = this.findById(id);
    if (!user) return null;
    user.backup_encrypted_session = encrypted_session;
    user.backup_phone = phone;
    user.backup_enabled = true; // adding a backup account turns it on by default
    await db.write();
    return user;
  },
  async setBackupEnabled(id, enabled) {
    const user = this.findById(id);
    if (!user) return null;
    user.backup_enabled = !!enabled;
    await db.write();
    return user;
  },
  async removeBackupAccount(id) {
    const user = this.findById(id);
    if (!user) return null;
    user.backup_encrypted_session = null;
    user.backup_phone = null;
    user.backup_enabled = false;
    await db.write();
    return user;
  },
};

export const Folders = {
  findById(id) { return db.data.folders.find((f) => f.id === id); },
  findByUser(userId, parentId) {
    return db.data.folders
      .filter((f) => f.user_id === userId && (f.parent_id || null) === (parentId || null))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  findByUserAndParentAndName(userId, parentId, name) {
    return db.data.folders.find(
      (f) => f.user_id === userId && (f.parent_id || null) === (parentId || null) && f.name === name
    );
  },
  async create({ id, user_id, name, parent_id }) {
    const record = { id, user_id, name, parent_id: parent_id || null, created_at: now() };
    db.data.folders.push(record);
    await db.write();
    return record;
  },
  async getOrCreatePath(userId, parentId, name) {
    let existing = this.findByUserAndParentAndName(userId, parentId, name);
    if (existing) return existing;
    const { v4: uuidv4 } = await import("uuid");
    return this.create({ id: uuidv4(), user_id: userId, name, parent_id: parentId });
  },
  breadcrumb(folderId) {
    const trail = [];
    let current = folderId ? this.findById(folderId) : null;
    while (current) {
      trail.unshift(current);
      current = current.parent_id ? this.findById(current.parent_id) : null;
    }
    return trail;
  },
  async remove(id) {
    const idx = db.data.folders.findIndex((f) => f.id === id);
    if (idx === -1) return false;
    db.data.folders.splice(idx, 1);
    await db.write();
    return true;
  },
};

export const Files = {
  async create(file) {
    const record = { visibility: "private", share_token: null, folder_id: null, backup_tg_message_id: null, created_at: now(), ...file };
    db.data.files.push(record);
    await db.write();
    return record;
  },
  findById(id) { return db.data.files.find((f) => f.id === id); },
  findByIdAndUser(id, userId) { return db.data.files.find((f) => f.id === id && f.user_id === userId); },
  findByUser(userId) {
    return db.data.files.filter((f) => f.user_id === userId).sort((a, b) => b.created_at - a.created_at);
  },
  findByUserAndFolder(userId, folderId) {
    return db.data.files
      .filter((f) => f.user_id === userId && (f.folder_id || null) === (folderId || null))
      .sort((a, b) => b.created_at - a.created_at);
  },
  findByShareToken(token) {
    return db.data.files.find((f) => f.share_token === token && f.visibility === "public");
  },
  all() { return db.data.files; },
  async update(id, changes) {
    const file = this.findById(id);
    if (!file) return null;
    Object.assign(file, changes);
    await db.write();
    return file;
  },
  async remove(id) {
    const idx = db.data.files.findIndex((f) => f.id === id);
    if (idx === -1) return false;
    db.data.files.splice(idx, 1);
    await db.write();
    return true;
  },
};

export const BannedIps = {
  all() { return db.data.bannedIps; },
  isBanned(ip) { return db.data.bannedIps.some((b) => b.ip === ip); },
  async ban(ip, reason = "") {
    if (this.isBanned(ip)) return;
    db.data.bannedIps.push({ ip, bannedAt: now(), reason });
    await db.write();
  },
  async unban(ip) {
    db.data.bannedIps = db.data.bannedIps.filter((b) => b.ip !== ip);
    await db.write();
  },
};

// ---------------------------------------------------------------------------
// Request stats — tracked in-memory for speed (a JSON-file DB write on
// every single incoming request would be far too slow), then flushed to
// disk periodically. A few seconds of counts could be lost on a hard crash,
// which is an acceptable tradeoff for not blocking every request on disk I/O.
// ---------------------------------------------------------------------------
function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export const RequestStats = {
  recordRequest(ip) {
    const stats = db.data.requestStats;
    stats.totalRequests++;
    const day = todayKey();
    stats.dailyCounts[day] = (stats.dailyCounts[day] || 0) + 1;
    const ipEntry = stats.ipStats[ip] || { count: 0, firstSeen: now(), lastSeen: now() };
    ipEntry.count++;
    ipEntry.lastSeen = now();
    stats.ipStats[ip] = ipEntry;
  },
  async flush() {
    await db.write();
  },
  overview() {
    const stats = db.data.requestStats;
    return {
      totalUsers: Object.keys(stats.ipStats).length,
      totalRequests: stats.totalRequests,
      todayRequests: stats.dailyCounts[todayKey()] || 0,
      bannedCount: db.data.bannedIps.length,
    };
  },
  ipList() {
    const stats = db.data.requestStats;
    return Object.entries(stats.ipStats)
      .map(([ip, s]) => ({ ip, ...s, banned: BannedIps.isBanned(ip) }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  },
  dailySeries(days = 14) {
    const stats = db.data.requestStats;
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({ date: key, count: stats.dailyCounts[key] || 0 });
    }
    return out;
  },
};

export default db;
