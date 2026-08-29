import React, { useEffect, useState } from "react";
import { apiUrl } from "./config.js";

async function adminApi(path, opts = {}) {
  const res = await fetch(apiUrl(`/admin${path}`), {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fmtSize(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / 1024 / 1024;
  if (mb > 1024) return (mb / 1024).toFixed(2) + " GB";
  return mb.toFixed(1) + " MB";
}
function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function StatusBadge({ status }) {
  const color = status >= 500 ? "var(--danger)" : status >= 400 ? "#f59e0b" : "var(--accent-2)";
  return <span style={{ background: color, color: "white", fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999 }}>{status}</span>;
}

function MethodBadge({ method }) {
  return <span className="badge private" style={{ fontFamily: "monospace" }}>{method}</span>;
}

function RequestInspectorModal({ logId, onClose, onBan }) {
  const [log, setLog] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("response");

  useEffect(() => {
    adminApi(`/requests/logs/${logId}`).then((r) => setLog(r.log)).catch((e) => setError(e.message));
  }, [logId]);

  const curlCommand = log
    ? [
        `curl -X ${log.method} "${window.location.origin.replace(/^https?:\/\/[^/]*/, "")}${log.path}"`,
        log.requestBody ? `  -H "Content-Type: application/json" \\\n  -d '${typeof log.requestBody === "string" ? log.requestBody : JSON.stringify(log.requestBody)}'` : "",
      ].filter(Boolean).join(" \\\n")
    : "";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <strong>Request Inspector</strong>
            {log && <div className="hint" style={{ margin: "2px 0 0" }}>ID: {log.id}</div>}
          </div>
          <button className="btn btn-sm" onClick={onClose}>✕</button>
        </div>

        {error && <div className="error-box">{error}</div>}
        {!log && !error && <p className="hint">Loading…</p>}

        {log && (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
              <MethodBadge method={log.method} /> <code>{log.path}</code>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {["response", "inspect", "replay"].map((t) => (
                <button key={t} className="btn btn-sm" style={tab === t ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}} onClick={() => setTab(t)}>
                  {t === "response" ? "Response" : t === "inspect" ? "Inspect Request" : "Replay Client"}
                </button>
              ))}
            </div>

            {tab === "response" && (
              <div>
                <div className="hint" style={{ margin: "0 0 6px" }}>Response body{log.responseBody == null ? " (not captured for this route)" : ""}</div>
                <pre style={{ maxHeight: 260, overflow: "auto" }}><code>{log.responseBody ?? "—"}</code></pre>
              </div>
            )}

            {tab === "inspect" && (
              <div style={{ fontSize: 13.5, display: "flex", flexDirection: "column", gap: 8 }}>
                <div><strong>Time:</strong> {fmtDate(log.time)}</div>
                <div><strong>Method:</strong> {log.method}</div>
                <div><strong>Path:</strong> <code>{log.path}</code></div>
                <div><strong>Status:</strong> <StatusBadge status={log.status} /></div>
                <div><strong>Latency:</strong> {log.latencyMs}ms</div>
                <div><strong>Client IP:</strong> <code>{log.ip}</code></div>
                <div><strong>Country:</strong> {log.country}</div>
                {log.requestBody && (
                  <div>
                    <strong>Request body (sensitive fields redacted):</strong>
                    <pre style={{ maxHeight: 160, overflow: "auto", marginTop: 6 }}><code>{typeof log.requestBody === "string" ? log.requestBody : JSON.stringify(log.requestBody, null, 2)}</code></pre>
                  </div>
                )}
              </div>
            )}

            {tab === "replay" && (
              <div>
                <p className="hint">
                  Copy this and run it yourself — for safety, requests aren't auto-replayed
                  server-side (some routes have real side effects, like uploads or deletes).
                </p>
                <pre style={{ maxHeight: 200, overflow: "auto" }}><code>{curlCommand}</code></pre>
                <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(curlCommand)}>Copy</button>
              </div>
            )}

            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-sm btn-danger" onClick={() => { onBan(log.ip); onClose(); }}>🚫 Ban this IP</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AdminLogin({ onLoggedIn }) {
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const login = async () => {
    setLoading(true);
    setError("");
    try {
      await adminApi("/login", { method: "POST", body: JSON.stringify({ id, password }) });
      onLoggedIn();
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="page animate-in">
      <div className="card auth-card">
        <h2>Admin Login</h2>
        <p className="hint">Metadata-only monitoring dashboard. Never exposes user Telegram sessions.</p>
        <input className="field" placeholder="Admin ID" value={id} onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && login()} />
        <input className="field" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && login()} />
        <button className="btn btn-primary" style={{ width: "100%" }} onClick={login} disabled={loading || !id || !password}>
          {loading ? "Checking…" : "Log in"}
        </button>
        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simple inline SVG bar chart — no charting library dependency needed for
// a straightforward "requests per day" view.
// ---------------------------------------------------------------------------
function DailyBarChart({ series }) {
  if (!series || series.length === 0) return null;
  const max = Math.max(1, ...series.map((s) => s.count));
  const width = 700, height = 160, barGap = 4;
  const barWidth = (width / series.length) - barGap;

  return (
    <svg viewBox={`0 0 ${width} ${height + 24}`} style={{ width: "100%", height: "auto" }}>
      {series.map((s, i) => {
        const h = Math.max(2, (s.count / max) * height);
        const x = i * (barWidth + barGap);
        const y = height - h;
        return (
          <g key={s.date}>
            <rect x={x} y={y} width={barWidth} height={h} rx={3} fill="var(--accent)" opacity={0.85}>
              <title>{s.date}: {s.count} requests</title>
            </rect>
            {i % 2 === 0 && (
              <text x={x + barWidth / 2} y={height + 16} fontSize="9" fill="var(--text-dim)" textAnchor="middle">
                {s.date.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function UnmaskModal({ onClose, onUnmasked }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    setError("");
    try {
      const r = await adminApi("/users/unmask", { method: "POST", body: JSON.stringify({ password }) });
      onUnmasked(r.users);
      onClose();
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>Confirm password to unmask</strong>
          <button className="btn btn-sm" onClick={onClose}>✕</button>
        </div>
        <p className="hint">Re-enter the admin password to view full, unmasked phone numbers. This is checked fresh every time — it isn't a setting that stays on.</p>
        <input className="field" type="password" placeholder="Admin password" value={password}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus />
        <button className="btn btn-primary" style={{ width: "100%" }} onClick={submit} disabled={loading || !password}>
          {loading ? "Checking…" : "Unmask"}
        </button>
        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}

function AdminDashboard({ onLogout }) {
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [files, setFiles] = useState([]);
  const [unmasked, setUnmasked] = useState(false);
  const [showUnmaskModal, setShowUnmaskModal] = useState(false);
  const [tab, setTab] = useState("users");
  const [error, setError] = useState("");

  // Traffic tab state
  const [trafficOverview, setTrafficOverview] = useState(null);
  const [dailySeries, setDailySeries] = useState([]);
  const [ips, setIps] = useState([]);
  const [banInput, setBanInput] = useState("");

  // Request Logs tab state
  const [logs, setLogs] = useState([]);
  const [logsOverview, setLogsOverview] = useState(null);
  const [inspectingLogId, setInspectingLogId] = useState(null);
  const [logsLoadingMore, setLogsLoadingMore] = useState(false);

  const load = async () => {
    try {
      const [ov, us, fl] = await Promise.all([
        adminApi("/overview"),
        adminApi("/users"),
        adminApi("/files"),
      ]);
      setOverview(ov);
      setUsers(us.users);
      setFiles(fl.files);
      setUnmasked(false); // any refresh reverts to masked — unmask is a one-shot view, not a persistent state
    } catch (e) {
      setError(e.message);
    }
  };

  const loadTraffic = async () => {
    try {
      const [ov, daily, ipList] = await Promise.all([
        adminApi("/requests/overview"),
        adminApi("/requests/daily"),
        adminApi("/requests/ips"),
      ]);
      setTrafficOverview(ov);
      setDailySeries(daily.series);
      setIps(ipList.ips);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (tab === "traffic") {
      loadTraffic();
      const interval = setInterval(loadTraffic, 8000);
      return () => clearInterval(interval);
    }
  }, [tab]);

  const loadLogs = async (reset = true) => {
    try {
      const [ov, logRes] = await Promise.all([
        adminApi("/requests/logs-overview"),
        adminApi("/requests/logs?limit=50"),
      ]);
      setLogsOverview(ov);
      setLogs(logRes.logs);
    } catch (e) { setError(e.message); }
  };

  const loadMoreLogs = async () => {
    if (logs.length === 0) return;
    setLogsLoadingMore(true);
    try {
      const r = await adminApi(`/requests/logs?limit=50&before=${logs[logs.length - 1].id}`);
      setLogs((prev) => [...prev, ...r.logs]);
    } catch (e) { setError(e.message); }
    setLogsLoadingMore(false);
  };

  useEffect(() => {
    if (tab === "logs") {
      loadLogs();
      const interval = setInterval(loadLogs, 10000);
      return () => clearInterval(interval);
    }
  }, [tab]);

  const banIp = async (ip) => {
    if (!confirm(`Ban ${ip}? This IP will get a 403 on every request to the site until unbanned.`)) return;
    try {
      await adminApi("/requests/ban", { method: "POST", body: JSON.stringify({ ip }) });
      await loadTraffic();
    } catch (e) { setError(e.message); }
  };

  const unbanIp = async (ip) => {
    try {
      await adminApi("/requests/unban", { method: "POST", body: JSON.stringify({ ip }) });
      await loadTraffic();
    } catch (e) { setError(e.message); }
  };

  const banManualIp = async () => {
    if (!banInput.trim()) return;
    try {
      await adminApi("/requests/ban", { method: "POST", body: JSON.stringify({ ip: banInput.trim() }) });
      setBanInput("");
      await loadTraffic();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="page animate-in">
      <div className="card" style={{ maxWidth: 1100 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>Admin — Monitoring</h2>
          <button className="btn btn-sm" onClick={onLogout}>Log out</button>
        </div>

        {error && <div className="error-box">{error}</div>}

        {overview && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 22 }}>
            {[
              ["Total users", overview.totalUsers],
              ["Total files", overview.totalFiles],
              ["Total storage", fmtSize(overview.totalStorageBytes)],
              ["Active today", overview.activeToday],
            ].map(([label, val]) => (
              <div key={label} className="feature-card" style={{ padding: 16 }}>
                <div className="hint" style={{ margin: 0 }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{val}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          <button className="btn btn-sm" style={tab === "users" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}} onClick={() => setTab("users")}>Users</button>
          <button className="btn btn-sm" style={tab === "files" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}} onClick={() => setTab("files")}>All Files</button>
          <button className="btn btn-sm" style={tab === "traffic" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}} onClick={() => setTab("traffic")}>Traffic & Bans</button>
          <button className="btn btn-sm" style={tab === "logs" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}} onClick={() => setTab("logs")}>Request Logs</button>
        </div>

        {tab === "users" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span className="hint" style={{ margin: 0 }}>
                {unmasked ? "⚠️ Showing full, unmasked phone numbers." : "Phone numbers are masked by default."}
              </span>
              {!unmasked ? (
                <button className="btn btn-sm" onClick={() => setShowUnmaskModal(true)}>🔓 Unmask (requires password)</button>
              ) : (
                <button className="btn btn-sm" onClick={() => load()}>🔒 Re-mask</button>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                    <th style={{ padding: 8 }}>Phone</th>
                    <th style={{ padding: 8 }}>Files</th>
                    <th style={{ padding: 8 }}>Storage</th>
                    <th style={{ padding: 8 }}>Joined</th>
                    <th style={{ padding: 8 }}>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={{ padding: 8, fontFamily: unmasked ? "monospace" : "inherit" }}>{u.phone}</td>
                      <td style={{ padding: 8 }}>{u.fileCount}</td>
                      <td style={{ padding: 8 }}>{fmtSize(u.storageBytes)}</td>
                      <td style={{ padding: 8 }}>{fmtDate(u.created_at)}</td>
                      <td style={{ padding: 8 }}>{fmtDate(u.last_active)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {users.length === 0 && <div className="empty-state">No users yet.</div>}
            </div>
          </div>
        )}

        {tab === "files" && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                  <th style={{ padding: 8 }}>Filename</th>
                  <th style={{ padding: 8 }}>Owner</th>
                  <th style={{ padding: 8 }}>Size</th>
                  <th style={{ padding: 8 }}>Visibility</th>
                  <th style={{ padding: 8 }}>Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: 8, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.filename}</td>
                    <td style={{ padding: 8 }}>{f.ownerPhone}</td>
                    <td style={{ padding: 8 }}>{fmtSize(f.size)}</td>
                    <td style={{ padding: 8 }}><span className={`badge ${f.visibility}`}>{f.visibility}</span></td>
                    <td style={{ padding: 8 }}>{fmtDate(f.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {files.length === 0 && <div className="empty-state">No files yet.</div>}
          </div>
        )}

        {tab === "traffic" && (
          <div>
            {trafficOverview && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
                {[
                  ["Unique visitors", trafficOverview.totalUsers],
                  ["Total requests", trafficOverview.totalRequests],
                  ["Today's requests", trafficOverview.todayRequests],
                  ["Banned IPs", trafficOverview.bannedCount],
                ].map(([label, val]) => (
                  <div key={label} className="feature-card" style={{ padding: 16 }}>
                    <div className="hint" style={{ margin: 0 }}>{label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{val}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="section-label"><span>📈 Requests — last 14 days</span></div>
            <div className="feature-card" style={{ padding: 16, marginBottom: 20 }}>
              <DailyBarChart series={dailySeries} />
            </div>

            <div className="section-label"><span>🚫 Ban an IP manually</span></div>
            <div className="inline-edit" style={{ maxWidth: 360, marginBottom: 16 }}>
              <input placeholder="e.g. 203.0.113.5" value={banInput} onChange={(e) => setBanInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && banManualIp()} />
              <button className="btn btn-sm btn-danger" onClick={banManualIp}>Ban</button>
            </div>

            <div className="section-label"><span>🌐 Known IPs</span></div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                    <th style={{ padding: 8 }}>IP</th>
                    <th style={{ padding: 8 }}>Requests</th>
                    <th style={{ padding: 8 }}>First seen</th>
                    <th style={{ padding: 8 }}>Last seen</th>
                    <th style={{ padding: 8 }}>Status</th>
                    <th style={{ padding: 8 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {ips.map((row) => (
                    <tr key={row.ip} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={{ padding: 8, fontFamily: "monospace" }}>{row.ip}</td>
                      <td style={{ padding: 8 }}>{row.count}</td>
                      <td style={{ padding: 8 }}>{fmtDate(row.firstSeen)}</td>
                      <td style={{ padding: 8 }}>{fmtDate(row.lastSeen)}</td>
                      <td style={{ padding: 8 }}>
                        {row.banned ? <span className="badge private" style={{ color: "var(--danger)" }}>Banned</span> : <span className="badge public">Active</span>}
                      </td>
                      <td style={{ padding: 8 }}>
                        {row.banned ? (
                          <button className="btn btn-sm" onClick={() => unbanIp(row.ip)}>Unban</button>
                        ) : (
                          <button className="btn btn-sm btn-danger" onClick={() => banIp(row.ip)}>Ban</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ips.length === 0 && <div className="empty-state">No traffic recorded yet.</div>}
            </div>
          </div>
        )}

        {tab === "logs" && (
          <div>
            {logsOverview && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
                {[
                  ["Logged (in memory)", logsOverview.totalLogged],
                  ["Last 24h", logsOverview.last24h],
                  ["Errors (5xx)", logsOverview.errors],
                ].map(([label, val]) => (
                  <div key={label} className="feature-card" style={{ padding: 16 }}>
                    <div className="hint" style={{ margin: 0 }}>{label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{val}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="section-label"><span>📋 Request Logs</span></div>
            <p className="hint" style={{ marginTop: -4 }}>
              Kept in memory only (most recent 2000 requests) — a debugging aid, not a permanent audit trail.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                    <th style={{ padding: 8 }}>Time</th>
                    <th style={{ padding: 8 }}>Path</th>
                    <th style={{ padding: 8 }}>Method</th>
                    <th style={{ padding: 8 }}>Status</th>
                    <th style={{ padding: 8 }}>Latency</th>
                    <th style={{ padding: 8 }}>IP</th>
                    <th style={{ padding: 8 }}>Country</th>
                    <th style={{ padding: 8 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={{ padding: 8, whiteSpace: "nowrap" }}>{fmtDate(log.time)}</td>
                      <td style={{ padding: 8, fontFamily: "monospace" }}>{log.path}</td>
                      <td style={{ padding: 8 }}><MethodBadge method={log.method} /></td>
                      <td style={{ padding: 8 }}><StatusBadge status={log.status} /></td>
                      <td style={{ padding: 8, color: log.latencyMs > 2000 ? "#f59e0b" : "inherit" }}>{log.latencyMs}ms</td>
                      <td style={{ padding: 8, fontFamily: "monospace" }}>{log.ip}</td>
                      <td style={{ padding: 8 }}>{log.country}</td>
                      <td style={{ padding: 8, display: "flex", gap: 6 }}>
                        <button className="uw-icon-btn" title="Inspect" onClick={() => setInspectingLogId(log.id)}>👁</button>
                        <button className="uw-icon-btn" title="Ban this IP" onClick={() => banIp(log.ip)}>🚫</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {logs.length === 0 && <div className="empty-state">No requests logged yet.</div>}
            </div>
            {logs.length > 0 && (
              <div style={{ textAlign: "center", marginTop: 14 }}>
                <button className="btn btn-sm" onClick={loadMoreLogs} disabled={logsLoadingMore}>
                  {logsLoadingMore ? "Loading…" : "Load More Logs"}
                </button>
              </div>
            )}
          </div>
        )}

        <p className="hint" style={{ marginTop: 18 }}>
          This dashboard shows metadata only. It never decrypts or displays user Telegram
          sessions — that data grants live account access and is intentionally kept out of
          reach here, even for admins.
        </p>
      </div>

      {inspectingLogId && (
        <RequestInspectorModal
          logId={inspectingLogId}
          onClose={() => setInspectingLogId(null)}
          onBan={banIp}
        />
      )}

      {showUnmaskModal && (
        <UnmaskModal
          onClose={() => setShowUnmaskModal(false)}
          onUnmasked={(fullUsers) => { setUsers(fullUsers); setUnmasked(true); }}
        />
      )}
    </div>
  );
}

export default function AdminPanel() {
  const [loggedIn, setLoggedIn] = useState(null);

  useEffect(() => {
    adminApi("/me").then((r) => setLoggedIn(r.isAdmin)).catch(() => setLoggedIn(false));
  }, []);

  const logout = async () => {
    await adminApi("/logout", { method: "POST" });
    setLoggedIn(false);
  };

  if (loggedIn === null) return null;
  return loggedIn ? <AdminDashboard onLogout={logout} /> : <AdminLogin onLoggedIn={() => setLoggedIn(true)} />;
}
