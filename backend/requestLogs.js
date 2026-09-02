import { v4 as uuidv4 } from "uuid";
import geoip from "geoip-lite";

const MAX_LOGS = 2000;
const MAX_BODY_CAPTURE_BYTES = 4 * 1024; // don't hold onto huge response bodies in memory

let logs = []; // newest first

export function countryForIp(ip) {
  if (!ip) return "Unknown";
  const clean = ip.replace(/^::ffff:/, ""); // normalize IPv4-mapped IPv6 addresses
  if (clean === "127.0.0.1" || clean === "::1") return "Local";
  const geo = geoip.lookup(clean);
  return geo?.country || "Unknown";
}

export function recordLog(entry) {
  logs.unshift({ id: uuidv4(), ...entry });
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
}

export function truncateBody(body) {
  if (body == null) return null;
  const str = typeof body === "string" ? body : JSON.stringify(body);
  if (str.length <= MAX_BODY_CAPTURE_BYTES) return str;
  return str.slice(0, MAX_BODY_CAPTURE_BYTES) + `… (truncated, ${str.length} bytes total)`;
}

export function getLogs({ limit = 50, before = null } = {}) {
  let list = logs;
  if (before) {
    const idx = logs.findIndex((l) => l.id === before);
    if (idx >= 0) list = logs.slice(idx + 1);
  }
  return list.slice(0, limit);
}

export function getLogById(id) {
  return logs.find((l) => l.id === id) || null;
}

export function logsOverview() {
  const now = Date.now();
  const last24h = logs.filter((l) => now - l.time < 24 * 60 * 60 * 1000).length;
  const errors = logs.filter((l) => l.status >= 500).length;
  return { totalLogged: logs.length, last24h, errors };
}
