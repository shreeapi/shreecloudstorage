import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import "./styles.css";
import AdminPanel from "./AdminPanel.jsx";
import { apiUrl, API_BASE } from "./config.js";

const APP_NAME = "ShreeCloudStorage";

// Custom icon set provided for the redesign — used in place of emoji
// wherever the corresponding UI element appears.
const ICON_URLS = {
  theme: "https://i.ibb.co/4wy5Vhgz/themes.png",
  photo: "https://i.ibb.co/GQhx3y7P/a1218a44a6d0.jpg",
  video: "https://i.ibb.co/N2P2xgzQ/09ceddd31036.jpg",
  other: "https://i.ibb.co/xKMqhVMR/7e08f43ffa1b.jpg",
  allFiles: "https://i.ibb.co/jPtXPzJ6/e7a8d0d6a61e.jpg",
  folder: "https://i.ibb.co/JFx42gt9/9bf95dcffff9.jpg",
  upload: "https://i.ibb.co/2YcV0n27/2b18f75fcda6.jpg",
  api: "https://i.ibb.co/Xxx5FX3x/5a7bf028a7c5.jpg",
};

function Icon({ src, alt = "", size = 20, style = {} }) {
  return (
    <img
      src={src}
      alt={alt}
      style={{ width: size, height: size, objectFit: "contain", display: "inline-block", verticalAlign: "middle", ...style }}
    />
  );
}

function FileTypeIcon({ mimetype = "", size = 22 }) {
  if (mimetype.startsWith("video/")) return <Icon src={ICON_URLS.video} size={size} />;
  if (mimetype.startsWith("image/")) return <Icon src={ICON_URLS.photo} size={size} />;
  if (mimetype.startsWith("audio/")) return <span style={{ fontSize: size }}>🎵</span>;
  if (mimetype.includes("pdf")) return <span style={{ fontSize: size }}>📄</span>;
  if (mimetype.includes("zip") || mimetype.includes("rar")) return <span style={{ fontSize: size }}>🗜️</span>;
  return <Icon src={ICON_URLS.other} size={size} />;
}
const GITHUB_REPO = "https://github.com/shreeapi/telecloud-storage";
const TG_CHANNEL_1 = "https://t.me/nepalimomoswala";
const TG_CHANNEL_2 = "https://t.me/shreeapi";

async function api(path, opts = {}) {
  const res = await fetch(apiUrl(path), {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fmtSize(bytes) {
  if (bytes == null) return "—";
  const mb = bytes / 1024 / 1024;
  if (mb > 1024) return (mb / 1024).toFixed(2) + " GB";
  return mb.toFixed(1) + " MB";
}
function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return "—";
  const mbps = bytesPerSec / 1024 / 1024;
  if (mbps < 1) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${mbps.toFixed(2)} MB/s`;
}
function fmtEta(seconds) {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s left`;
}
// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function navigate(path) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event("locationchange"));
}
function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onChange);
    window.addEventListener("locationchange", onChange);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.removeEventListener("locationchange", onChange);
    };
  }, []);
  return path;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const THEMES = [
  { id: "light", icon: "☀️", label: "Light" },
  { id: "dark", icon: "🌙", label: "Dark" },
  { id: "soft", icon: "🌾", label: "Soft" },
];
function useTheme() {
  const [theme, setTheme] = useState(localStorage.getItem("tc-theme") || "light");
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("tc-theme", theme);
  }, [theme]);
  return [theme, setTheme];
}
function BubbleBackground() {
  return (
    <div className="bubble-bg">
      <div className="blob blob-1" />
      <div className="blob blob-2" />
      <div className="blob blob-3" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Global upload manager — lives at the App root so uploads keep running (and
// stay visible in a floating widget) no matter which page the user browses
// to. This is what lets someone kick off an upload and go explore the rest
// of the site while it finishes in the background.
// ---------------------------------------------------------------------------
const UploadContext = createContext(null);
function useUploadContext() { return useContext(UploadContext); }

function useUploadManager(onAnyUploaded) {
  const [uploads, setUploads] = useState([]); // {id, name, size, phase, pct, speed, eta, error, sessionId}
  const controlRef = useRef(new Map()); // id -> { cancelled, controller }

  const patch = (uid, changes) => setUploads((u) => u.map((x) => (x.id === uid ? { ...x, ...changes } : x)));

  const uploadOne = async (file, { folderId, relativePath } = {}) => {
    const uid = Math.random().toString(36).slice(2);
    controlRef.current.set(uid, { cancelled: false, controller: null });
    setUploads((u) => [
      ...u,
      { id: uid, name: file.name, size: file.size, phase: "server", pct: 0, speed: 0, eta: null, error: null, paused: false, sessionId: null },
    ]);

    const isCancelled = () => controlRef.current.get(uid)?.cancelled;

    try {
      // 1. Start a chunked upload session on the server.
      const init = await api("/files/upload/init", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, fileSize: file.size, mimetype: file.type, folder_id: folderId, relativePath }),
      });
      if (isCancelled()) return;
      const { sessionId, chunkSize } = init;
      patch(uid, { sessionId });

      // 2. Open the SSE stream for live progress during the (later)
      // server -> Telegram leg, keyed by this same sessionId.
      const es = new EventSource(apiUrl(`/files/upload-progress/${sessionId}`));
      es.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.phase === "telegram") {
          const remaining = data.total - data.bytes;
          const eta = data.speed > 0 ? remaining / data.speed : null;
          patch(uid, { phase: "telegram", pct: data.pct, speed: data.speed, eta });
        } else if (data.phase === "done") {
          patch(uid, { phase: "done", pct: 100, eta: 0 });
          es.close();
        } else if (data.phase === "error") {
          patch(uid, { error: data.error });
          es.close();
        }
      };
      es.onerror = () => es.close();

      // 3. Upload the file in sequential chunks. On a network failure this
      // pauses (not fails, not cancels) and quietly retries the SAME chunk
      // — first the instant the browser reports connectivity back, and
      // also on a steady timer as a fallback — until it gets through.
      let offset = 0;
      const uploadStartTime = Date.now();
      let lastTime = uploadStartTime;
      let lastOffset = 0;

      const sendChunk = async () => {
        const chunk = file.slice(offset, offset + chunkSize);
        const controller = new AbortController();
        controlRef.current.get(uid).controller = controller;

        const res = await fetch(apiUrl(`/files/upload/chunk/${sessionId}?offset=${offset}`), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/octet-stream" },
          body: chunk,
          signal: controller.signal,
        });

        if (res.status === 409) {
          // Server and client disagree on position (e.g. our last "success"
          // never actually landed before the connection dropped) — realign
          // to whatever the server really has and keep going from there.
          const data = await res.json().catch(() => ({}));
          if (typeof data.expectedOffset === "number") offset = data.expectedOffset;
          return; // retry loop below will re-send from the corrected offset
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Upload failed (${res.status})`);
        }

        offset += chunk.size;
      };

      const waitForOnline = () => new Promise((resolve) => {
        if (navigator.onLine) return resolve();
        const handler = () => { window.removeEventListener("online", handler); resolve(); };
        window.addEventListener("online", handler);
        // Fallback poll in case the 'online' event doesn't fire reliably on this network/browser.
        const poll = setInterval(() => {
          if (navigator.onLine) { clearInterval(poll); window.removeEventListener("online", handler); resolve(); }
        }, 3000);
      });

      while (offset < file.size) {
        if (isCancelled()) { es.close(); return; }
        try {
          await sendChunk();
          patch(uid, { paused: false });
        } catch (err) {
          if (isCancelled() || err.name === "AbortError") { es.close(); return; }
          // A dropped connection (network error, timeout, DNS blip, etc.)
          // pauses the upload — it does NOT show an error and does NOT
          // cancel. We just wait for the network to come back and retry
          // the exact same chunk.
          patch(uid, { paused: true, phase: "server" });
          await waitForOnline();
          await new Promise((r) => setTimeout(r, 500)); // brief settle time after reconnect
          continue; // retry same offset
        }

        const now = Date.now();
        const dt = (now - lastTime) / 1000;
        const elapsedTotal = (now - uploadStartTime) / 1000;
        const pct = Math.round((offset / file.size) * 100);
        if (dt >= 0.2 || offset >= file.size) {
          const speed = dt > 0 ? (offset - lastOffset) / dt : (elapsedTotal > 0.05 ? offset / elapsedTotal : 0);
          const remaining = file.size - offset;
          const eta = speed > 0 ? remaining / speed : null;
          patch(uid, { pct, speed, eta, phase: "server" });
          lastTime = now; lastOffset = offset;
        } else {
          patch(uid, { pct });
        }
      }

      if (isCancelled()) { es.close(); return; }

      // 4. All bytes received server-side — trigger the actual Telegram
      // upload. Progress continues to arrive over the same SSE connection.
      await api(`/files/upload/complete/${sessionId}`, { method: "POST" });
      setTimeout(() => setUploads((u) => u.filter((x) => x.id !== uid)), 2200);
      onAnyUploaded?.();
    } catch (err) {
      if (!isCancelled()) patch(uid, { error: err.message || "Upload failed" });
    } finally {
      controlRef.current.delete(uid);
    }
  };

  const addFiles = (fileList, opts) => Array.from(fileList).forEach((f) => uploadOne(f, opts));

  // Folder-aware add: expects real File objects that may carry webkitRelativePath
  // (set automatically by <input webkitdirectory> or a folder drag-drop).
  const addFilesWithPaths = (fileList, folderId) => {
    Array.from(fileList).forEach((file) => {
      const rel = file.webkitRelativePath || "";
      const relDir = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "";
      uploadOne(file, { folderId, relativePath: relDir });
    });
  };

  const cancel = (id) => {
    const ctrl = controlRef.current.get(id);
    if (ctrl) {
      ctrl.cancelled = true;
      ctrl.controller?.abort();
    }
    const u = uploads.find((x) => x.id === id);
    if (u?.sessionId) {
      fetch(apiUrl(`/files/upload/abort/${u.sessionId}`), { method: "POST", credentials: "include" }).catch(() => {});
    }
    patch(id, { error: "Cancelled" });
  };

  const dismiss = (id) => setUploads((u) => u.filter((x) => x.id !== id));

  return { uploads, addFiles, addFilesWithPaths, cancel, dismiss };
}

function UploadWidget() {
  const { uploads, dismiss, cancel } = useUploadContext();
  const [size, setSize] = useState("normal"); // 'mini' | 'normal' | 'large'

  if (uploads.length === 0) return null;

  const active = uploads.filter((u) => !u.error && u.phase !== "done");
  const paused = uploads.filter((u) => u.paused && !u.error);
  const overallPct = uploads.length
    ? Math.round(uploads.reduce((s, u) => s + u.pct, 0) / uploads.length)
    : 0;

  const phaseLabel = (u) => {
    if (u.error) return u.error === "Cancelled" ? "Cancelled" : "Failed";
    if (u.paused) return "⏸ Paused — waiting for connection…";
    if (u.phase === "server") return "Uploading to server…";
    if (u.phase === "telegram") return "Uploading to Telegram…";
    return "Done ✓";
  };

  return (
    <div className={`upload-widget ${size}`}>
      <div className="uw-header" onClick={() => setSize(size === "mini" ? "normal" : "mini")}>
        <div className="uw-title">
          {active.length > 0 && <div className={"uw-spinner" + (paused.length === active.length ? " uw-spinner-paused" : "")} />}
          {active.length > 0
            ? (paused.length > 0
                ? `${paused.length} paused, waiting for connection…`
                : `Uploading ${uploads.length - active.length + 1}/${uploads.length} file${uploads.length > 1 ? "s" : ""}`)
            : `${uploads.length} file${uploads.length > 1 ? "s" : ""} done`}
        </div>
        <div className="uw-controls">
          {size !== "mini" && (
            <button
              className="uw-icon-btn"
              title={size === "large" ? "Shrink" : "Enlarge"}
              onClick={(e) => { e.stopPropagation(); setSize(size === "large" ? "normal" : "large"); }}
            >
              {size === "large" ? "⤡" : "⤢"}
            </button>
          )}
          <button className="uw-icon-btn" title={size === "mini" ? "Expand" : "Minimize"}>
            {size === "mini" ? "▲" : "▼"}
          </button>
        </div>
      </div>
      {size === "mini" ? (
        <div className="uw-mini-bar"><div className="uw-mini-fill" style={{ width: `${overallPct}%` }} /></div>
      ) : (
        <div className="uw-body">
          {uploads.map((u) => (
            <div className="upload-row" key={u.id}>
              <div className="upload-top">
                <div className="upload-info">
                  <div className="upload-name">{u.name} <span style={{ color: "var(--text-dim)" }}>· {fmtSize(u.size)}</span></div>
                  {u.error ? (
                    <div className="error-box" style={{ marginTop: 4 }}>{u.error}</div>
                  ) : (
                    <div className="progress-track"><div className="progress-fill" style={{ width: `${u.pct}%` }} /></div>
                  )}
                </div>
                {!u.error && <div className="upload-pct">{u.pct}%</div>}
                {!u.error && u.phase !== "done" && (
                  <button className="uw-icon-btn" title="Cancel" onClick={() => cancel(u.id)}>✕</button>
                )}
                {(u.error || u.phase === "done") && (
                  <button className="uw-icon-btn" title="Dismiss" onClick={() => dismiss(u.id)}>✕</button>
                )}
              </div>
              {!u.error && (
                <div className="upload-stats">
                  <span>{phaseLabel(u)}</span>
                  {(u.phase === "server" || u.phase === "telegram") && u.speed > 0 && <span>⚡ {fmtSpeed(u.speed)}</span>}
                  {(u.phase === "server" || u.phase === "telegram") && u.pct < 100 && <span>⏱ {fmtEta(u.eta)}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------
function ProfileBadge() {
  const [profile, setProfile] = useState(null);
  const [photoFailed, setPhotoFailed] = useState(false);

  useEffect(() => {
    api("/auth/profile").then(setProfile).catch(() => {});
  }, []);

  if (!profile) return null;
  const initials = ((profile.firstName?.[0] || "") + (profile.lastName?.[0] || "")).toUpperCase() || "?";

  return (
    <div className="profile-badge" title={(profile.phone || "") + " — click for Settings"} onClick={() => navigate("/settings")} style={{ cursor: "pointer" }}>
      {!photoFailed ? (
        <img
          className="profile-avatar"
          src={apiUrl("/auth/profile-photo")}
          alt=""
          onError={() => setPhotoFailed(true)}
        />
      ) : (
        <div className="profile-avatar profile-avatar-fallback">{initials}</div>
      )}
      <span className="profile-name">{profile.firstName} {profile.lastName}</span>
    </div>
  );
}

function NavBar({ loggedIn, onLogout, path, theme, setTheme }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const link = (to, label) => (
    <a className={path === to ? "active" : ""} onClick={() => { navigate(to); setMobileOpen(false); }}>{label}</a>
  );
  const isDark = theme === "dark";

  useEffect(() => { setMobileOpen(false); }, [path]);

  return (
    <div className="nav-wrap">
      <div className="nav">
        <div className="brand" onClick={() => navigate("/")}>
          <div className="brand-badge">☁️</div>
          <span className="brand-shree">Shree</span><span className="brand-rest">CloudStorage</span>
        </div>

        {/* Desktop links — hidden below the mobile breakpoint */}
        <div className="nav-links nav-links-desktop">
          {link("/", "Home")}
          {loggedIn && link("/upload", "Upload")}
          {loggedIn && link("/library", "Library")}
          {loggedIn && link("/api", "API")}
          {link("/docs", "Docs")}
        </div>

        <div className="nav-right">
          {loggedIn && <ProfileBadge />}
          <button
            className="theme-toggle-single"
            title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
            onClick={() => setTheme(isDark ? "light" : "dark")}
          >
            <Icon src={ICON_URLS.theme} size={18} />
          </button>
          {loggedIn ? (
            <button className="btn btn-sm nav-logout-desktop" onClick={onLogout}>Log out</button>
          ) : (
            <button className="btn btn-primary btn-sm nav-logout-desktop" onClick={() => navigate("/login")}>Log in</button>
          )}
          {/* Hamburger — only shown below the mobile breakpoint */}
          <button className="nav-hamburger" onClick={() => setMobileOpen((v) => !v)} aria-label="Menu">
            {mobileOpen ? "✕" : "☰"}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="nav-mobile-menu">
          {link("/", "🏠 Home")}
          {loggedIn && link("/upload", <><Icon src={ICON_URLS.upload} size={16} /> Upload</>)}
          {loggedIn && link("/library", "📚 Library")}
          {loggedIn && link("/api", <><Icon src={ICON_URLS.api} size={16} /> API</>)}
          {loggedIn && link("/settings", "🛡️ Settings")}
          {link("/docs", "📖 Docs")}
          <div className="nav-mobile-divider" />
          {loggedIn ? (
            <button className="btn btn-sm" style={{ width: "100%" }} onClick={() => { onLogout(); setMobileOpen(false); }}>Log out</button>
          ) : (
            <button className="btn btn-primary btn-sm" style={{ width: "100%" }} onClick={() => { navigate("/login"); setMobileOpen(false); }}>Log in</button>
          )}
        </div>
      )}
    </div>
  );
}

function Footer() {
  return (
    <footer className="site-footer-premium">
      <div className="footer-columns">
        <div className="footer-col">
          <div className="brand" style={{ marginBottom: 10 }}>
            <div className="brand-badge">☁️</div>
            <span className="brand-shree">Shree</span><span className="brand-rest">CloudStorage</span>
          </div>
          <p className="footer-desc">Free, unlimited cloud storage backed by your own Telegram account.</p>
        </div>
        <div className="footer-col">
          <div className="footer-col-title">Documentation</div>
          <a onClick={() => navigate("/docs")}>Quick Start</a>
          <a onClick={() => navigate("/api")}>API</a>
          <a href={GITHUB_REPO} target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <div className="footer-col">
          <div className="footer-col-title">Community</div>
          <a href={TG_CHANNEL_2} target="_blank" rel="noreferrer">Telegram — t.me/shreeapi</a>
          <a href={TG_CHANNEL_1} target="_blank" rel="noreferrer">Telegram — t.me/nepalimomoswala</a>
          <a href={GITHUB_REPO} target="_blank" rel="noreferrer">GitHub Discussions</a>
        </div>
        <div className="footer-col">
          <div className="footer-col-title">Support</div>
          <a onClick={() => navigate("/docs")}>Docs & FAQ</a>
          <a onClick={() => navigate("/admin")}>Status (Admin)</a>
        </div>
      </div>
      <div className="footer-bottom">
        <span>Made with ❤️ by ShreeAPI</span>
        <span>{APP_NAME} · © {new Date().getFullYear()}</span>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------
function useTypewriter(text, { typeSpeed = 55, deleteSpeed = 30, pauseAfterType = 1800, pauseAfterDelete = 400 } = {}) {
  const [display, setDisplay] = useState("");
  useEffect(() => {
    let i = 0;
    let deleting = false;
    let timeoutId;

    const tick = () => {
      if (!deleting) {
        i++;
        setDisplay(text.slice(0, i));
        if (i >= text.length) {
          deleting = true;
          timeoutId = setTimeout(tick, pauseAfterType);
          return;
        }
        timeoutId = setTimeout(tick, typeSpeed);
      } else {
        i--;
        setDisplay(text.slice(0, i));
        if (i <= 0) {
          deleting = false;
          timeoutId = setTimeout(tick, pauseAfterDelete);
          return;
        }
        timeoutId = setTimeout(tick, deleteSpeed);
      }
    };

    timeoutId = setTimeout(tick, typeSpeed);
    return () => clearTimeout(timeoutId);
  }, [text]);
  return display;
}

function Landing() {
  const headline = useTypewriter("Your Telegram account, as unlimited storage.");
  return (
    <div className="animate-in">
      <div className="hero">
        <div>
          <h1 className="typewriter-h1">{headline}<span className="typewriter-cursor">&nbsp;</span></h1>
          <p>
            Log in with your own Telegram account, upload files of any size (one at a time or
            many at once), keep browsing while they upload in the background, stream instantly,
            and share public or private links — all backed by your own Saved Messages.
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary" onClick={() => navigate("/login")}>Get Started</button>
            <button className="btn" onClick={() => navigate("/docs")}>Read the Docs</button>
          </div>
        </div>
        <div className="hero-visual">
          <img src="https://i.ibb.co/ZpjyjjFr/cloud-server.png" alt="Cloud storage" className="hero-cloud-img" />
        </div>
      </div>

      <div className="features">
        <div className="feature-card">
          <div className="feature-icon"><img src="https://i.ibb.co/wZZ0dBYC/power.png" alt="" /></div>
          <h4>Lightning uploads</h4>
          <p>Upload multiple files at once, in up to 16 parallel parts each, with live real-world speed shown as it goes.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon"><img src="https://i.ibb.co/PvzN1Srh/smartphone.png" alt="" /></div>
          <h4>Upload & keep exploring</h4>
          <p>Minimize the upload tray and browse the rest of the site — your files keep uploading in the background.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon"><img src="https://i.ibb.co/GNckxJy/link.png" alt="" /></div>
          <h4>Public or private links</h4>
          <p>Share any file with a public link, or keep it private to your account only.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon"><img src="https://i.ibb.co/VpV7ZR7q/unlimited.png" alt="" /></div>
          <h4>Effectively unlimited</h4>
          <p>Storage lives on Telegram's servers, not ours — so you're limited only by your Telegram account.</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function QrLoginBox({ onLoggedIn }) {
  const [requestId, setRequestId] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [status, setStatus] = useState("connecting"); // connecting | waiting | password_required | error
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const pollRef = useRef(null);

  const start = async () => {
    setError("");
    setStatus("connecting");
    setQrDataUrl(null);
    try {
      const { requestId } = await api("/auth/qr/start", { method: "POST" });
      setRequestId(requestId);
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  };

  useEffect(() => { start(); return () => clearInterval(pollRef.current); }, []);

  useEffect(() => {
    if (!requestId) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await api(`/auth/qr/poll/${requestId}`);
        setStatus(r.status);
        if (r.qrDataUrl) setQrDataUrl(r.qrDataUrl);
        if (r.status === "success") {
          clearInterval(pollRef.current);
          onLoggedIn();
          navigate("/library");
        } else if (r.status === "error") {
          clearInterval(pollRef.current);
          setError(r.error || "QR login failed");
        }
      } catch (e) {
        clearInterval(pollRef.current);
        setError(e.message);
        setStatus("error");
      }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [requestId]);

  const submitPassword = async () => {
    if (!password) return;
    try {
      await api(`/auth/qr/password/${requestId}`, { method: "POST", body: JSON.stringify({ password }) });
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="qr-box">
      <p className="hint" style={{ margin: 0 }}>Open Telegram on your phone → Settings → Devices → Link Desktop Device, then scan this code.</p>
      <div className="qr-image-wrap">
        {qrDataUrl ? <img src={qrDataUrl} alt="Login QR code" /> : <div className="qr-loading-spinner" />}
      </div>
      {status === "password_required" && (
        <>
          <input className="field" style={{ marginBottom: 0 }} type="password" placeholder="2FA password"
            value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitPassword()} />
          <button className="btn btn-primary" style={{ width: "100%" }} onClick={submitPassword}>Confirm</button>
        </>
      )}
      {error && (
        <>
          <div className="error-box" style={{ width: "100%" }}>{error}</div>
          <button className="btn btn-sm" onClick={start}>Try again</button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Country dial codes — searchable selector for the phone login field.
// ---------------------------------------------------------------------------
const COUNTRIES = [
  { name: "India", dial: "+91", flag: "🇮🇳" },
  { name: "United States", dial: "+1", flag: "🇺🇸" },
  { name: "United Kingdom", dial: "+44", flag: "🇬🇧" },
  { name: "Pakistan", dial: "+92", flag: "🇵🇰" },
  { name: "Bangladesh", dial: "+880", flag: "🇧🇩" },
  { name: "Nepal", dial: "+977", flag: "🇳🇵" },
  { name: "Sri Lanka", dial: "+94", flag: "🇱🇰" },
  { name: "United Arab Emirates", dial: "+971", flag: "🇦🇪" },
  { name: "Saudi Arabia", dial: "+966", flag: "🇸🇦" },
  { name: "Qatar", dial: "+974", flag: "🇶🇦" },
  { name: "Kuwait", dial: "+965", flag: "🇰🇼" },
  { name: "Canada", dial: "+1", flag: "🇨🇦" },
  { name: "Australia", dial: "+61", flag: "🇦🇺" },
  { name: "Germany", dial: "+49", flag: "🇩🇪" },
  { name: "France", dial: "+33", flag: "🇫🇷" },
  { name: "Italy", dial: "+39", flag: "🇮🇹" },
  { name: "Spain", dial: "+34", flag: "🇪🇸" },
  { name: "Netherlands", dial: "+31", flag: "🇳🇱" },
  { name: "Russia", dial: "+7", flag: "🇷🇺" },
  { name: "China", dial: "+86", flag: "🇨🇳" },
  { name: "Japan", dial: "+81", flag: "🇯🇵" },
  { name: "South Korea", dial: "+82", flag: "🇰🇷" },
  { name: "Indonesia", dial: "+62", flag: "🇮🇩" },
  { name: "Malaysia", dial: "+60", flag: "🇲🇾" },
  { name: "Singapore", dial: "+65", flag: "🇸🇬" },
  { name: "Philippines", dial: "+63", flag: "🇵🇭" },
  { name: "Thailand", dial: "+66", flag: "🇹🇭" },
  { name: "Vietnam", dial: "+84", flag: "🇻🇳" },
  { name: "Turkey", dial: "+90", flag: "🇹🇷" },
  { name: "Egypt", dial: "+20", flag: "🇪🇬" },
  { name: "Nigeria", dial: "+234", flag: "🇳🇬" },
  { name: "South Africa", dial: "+27", flag: "🇿🇦" },
  { name: "Kenya", dial: "+254", flag: "🇰🇪" },
  { name: "Brazil", dial: "+55", flag: "🇧🇷" },
  { name: "Mexico", dial: "+52", flag: "🇲🇽" },
  { name: "Argentina", dial: "+54", flag: "🇦🇷" },
  { name: "Nepal", dial: "+977", flag: "🇳🇵" },
  { name: "Afghanistan", dial: "+93", flag: "🇦🇫" },
];

function CountrySelector({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef();

  useEffect(() => {
    const onClickOutside = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const filtered = COUNTRIES.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) || c.dial.includes(search)
  );
  const selected = COUNTRIES.find((c) => c.dial === value) || COUNTRIES[0];

  return (
    <div className="country-select" ref={wrapRef}>
      <button type="button" className="country-select-trigger" onClick={() => setOpen((v) => !v)}>
        <span>{selected.flag}</span>
        <span>{selected.dial}</span>
        <span className="country-select-caret">▾</span>
      </button>
      {open && (
        <div className="country-select-panel">
          <input
            className="field"
            style={{ marginBottom: 8 }}
            placeholder="Search country or code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="country-select-list">
            {filtered.map((c) => (
              <div
                key={c.name + c.dial}
                className="country-select-item"
                onClick={() => { onChange(c.dial); setOpen(false); setSearch(""); }}
              >
                <span>{c.flag}</span>
                <span style={{ flex: 1 }}>{c.name}</span>
                <span className="hint" style={{ margin: 0 }}>{c.dial}</span>
              </div>
            ))}
            {filtered.length === 0 && <div className="hint" style={{ padding: 8 }}>No matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function LoginForm({ onLoggedIn }) {
  const [mode, setMode] = useState("phone"); // 'phone' | 'qr'
  const [countryDial, setCountryDial] = useState("+91");
  const [localNumber, setLocalNumber] = useState("");
  const [requestId, setRequestId] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const phone = `${countryDial}${localNumber.replace(/\D/g, "")}`;

  const sendCode = async () => {
    setLoading(true);
    setError("");
    try {
      const { requestId } = await api("/auth/send-code", { method: "POST", body: JSON.stringify({ phone }) });
      setRequestId(requestId);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const verify = async () => {
    setLoading(true);
    setError("");
    try {
      await api("/auth/verify-code", {
        method: "POST",
        body: JSON.stringify({ requestId, code, password: needsPassword ? password : undefined }),
      });
      onLoggedIn();
      navigate("/library");
    } catch (e) {
      if (e.message === "2FA_PASSWORD_REQUIRED") setNeedsPassword(true);
      else setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="page animate-in">
      <div className="card auth-card">
        <h2>Log in with Telegram</h2>

        {mode === "phone" && !requestId && (
          <>
            <p className="hint">Enter your Telegram phone number with country code.</p>
            <div className="phone-input-row">
              <CountrySelector value={countryDial} onChange={setCountryDial} />
              <input className="field" style={{ marginBottom: 0 }} placeholder="234 567 8900" value={localNumber}
                onChange={(e) => setLocalNumber(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendCode()} />
            </div>
            <button className="btn btn-primary" style={{ width: "100%", marginTop: 12 }} onClick={sendCode} disabled={loading || !localNumber}>
              {loading ? "Sending…" : "Send Code"}
            </button>
          </>
        )}
        {mode === "phone" && requestId && (
          <>
            <p className="hint">Check your Telegram app for the login code.</p>
            <input className="field" placeholder="Login code" value={code}
              onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && verify()} />
            {needsPassword && (
              <input className="field" placeholder="2FA password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && verify()} />
            )}
            <button className="btn btn-primary" style={{ width: "100%" }} onClick={verify} disabled={loading || !code}>
              {loading ? "Verifying…" : "Verify"}
            </button>
          </>
        )}
        {mode === "qr" && <QrLoginBox onLoggedIn={onLoggedIn} />}

        {error && <div className="error-box">{error}</div>}

        <div className="qr-toggle-row">
          {mode === "phone" ? (
            <a onClick={() => { setMode("qr"); setError(""); }}>📷 Log in with QR code instead</a>
          ) : (
            <a onClick={() => { setMode("phone"); setError(""); }}>📱 Log in with phone number instead</a>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload page — just the dropzone; actual progress lives in the global
// floating widget so it survives navigating to other pages.
// ---------------------------------------------------------------------------
function UploadPage() {
  const { addFiles, addFilesWithPaths } = useUploadContext();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef();
  const folderInputRef = useRef();

  const handleFiles = (fileList) => addFiles(fileList);
  const handleFolder = (fileList) => addFilesWithPaths(fileList, null);

  return (
    <div className="page animate-in">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Upload</h2>
        <p className="hint">Select or drop as many files (or a whole folder) as you like — they'll upload together, and you can keep browsing the rest of {APP_NAME} while they finish (check the tray in the corner).</p>
        <div
          className={"dropzone" + (dragOver ? " dragover" : "")}
          onClick={() => inputRef.current.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
        >
          <div style={{ marginBottom: 8, display: "flex", justifyContent: "center" }}><Icon src={ICON_URLS.upload} size={32} /></div>
          <div>Drag & drop files here, or click to browse</div>
          <div className="hint" style={{ marginTop: 6 }}>Multiple files supported · 16 parallel parts per file for speed</div>
          <input ref={inputRef} type="file" multiple onChange={(e) => e.target.files.length && handleFiles(e.target.files)} />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => folderInputRef.current.click()}><Icon src={ICON_URLS.folder} size={16} /> Upload a whole folder</button>
          <button className="btn" onClick={() => navigate("/library")}>Go to Library →</button>
        </div>
        <input
          ref={folderInputRef}
          type="file"
          webkitdirectory=""
          directory=""
          multiple
          style={{ display: "none" }}
          onChange={(e) => e.target.files.length && handleFolder(e.target.files)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Player modal
// ---------------------------------------------------------------------------
function PlayerModal({ file, onClose }) {
  if (!file) return null;
  const src = apiUrl(`/files/${file.id}/stream`);
  const isVideo = file.mimetype?.startsWith("video/");
  const isImage = file.mimetype?.startsWith("image/");
  const isAudio = file.mimetype?.startsWith("audio/");
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{file.filename}</strong>
          <button className="btn btn-sm" onClick={onClose}>✕ Close</button>
        </div>
        {isVideo && <video src={src} controls autoPlay />}
        {isAudio && <audio src={src} controls autoPlay style={{ width: "100%" }} />}
        {isImage && <img src={src} alt={file.filename} />}
        {!isVideo && !isAudio && !isImage && (
          <div style={{ padding: 30, textAlign: "center" }}>
            <p>Preview not supported for this file type.</p>
            <a className="btn btn-primary" href={src} download={file.filename}>Download</a>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library page
// ---------------------------------------------------------------------------
function StorageGauge({ segments, totalBytes }) {
  // segments: [{ label, bytes, color }]
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const total = totalBytes || 1;

  return (
    <div className="gauge-wrap">
      <svg viewBox="0 0 140 140">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--border)" strokeWidth="14" />
        {segments.map((seg, i) => {
          const frac = seg.bytes / total;
          const dash = frac * circumference;
          const circle = (
            <circle
              key={i}
              cx="70" cy="70" r={radius} fill="none"
              stroke={seg.color} strokeWidth="14"
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              strokeLinecap="round"
            />
          );
          offset += dash;
          return circle;
        })}
      </svg>
      <div className="gauge-center">
        <div className="pct">{fmtSize(totalBytes)}</div>
        <div className="lbl">Total used</div>
      </div>
    </div>
  );
}

function StorageOverview({ allFiles, filter, setFilter, search, setSearch }) {
  const totalBytes = allFiles.reduce((s, f) => s + (f.size || 0), 0);
  const bytesOf = (pred) => allFiles.filter(pred).reduce((s, f) => s + (f.size || 0), 0);
  const countOf = (pred) => allFiles.filter(pred).length;

  const videoBytes = bytesOf((f) => f.mimetype?.startsWith("video/"));
  const imageBytes = bytesOf((f) => f.mimetype?.startsWith("image/"));
  const otherBytes = Math.max(totalBytes - videoBytes - imageBytes, 0);

  const cats = [
    { id: "video", label: "Videos", sub: `${countOf((f) => f.mimetype?.startsWith("video/"))} files`, bytes: videoBytes, cls: "cat-videos", icon: ICON_URLS.video, color: "#1d4ed8" },
    { id: "image", label: "Photos", sub: `${countOf((f) => f.mimetype?.startsWith("image/"))} files`, bytes: imageBytes, cls: "cat-images", icon: ICON_URLS.photo, color: "#7c3aed" },
    { id: "other", label: "Other", sub: `${countOf((f) => !f.mimetype?.startsWith("video/") && !f.mimetype?.startsWith("image/"))} files`, bytes: otherBytes, cls: "cat-other", icon: ICON_URLS.other, color: "#b45309" },
    { id: "all", label: "All Files", sub: `${allFiles.length} files`, bytes: totalBytes, cls: "cat-all", icon: ICON_URLS.allFiles, color: "#047857" },
  ];

  return (
    <>
      <div className="storage-header">
        <div>
          <h2>My Storage</h2>
          <p className="hint">Everything you've uploaded to your Telegram Saved Messages</p>
        </div>
        <div className="search-bar">
          🔍 <input placeholder="Search files…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="storage-grid">
        <div className="category-cards">
          {cats.map((c) => (
            <div key={c.id} className={`category-card ${c.cls} ${filter === c.id ? "active" : ""}`} onClick={() => setFilter(c.id === "all" ? "all" : c.id)}>
              <div className="cat-icon"><Icon src={c.icon} size={22} /></div>
              <div>
                <div className="cat-label">{c.label}</div>
                <div className="cat-sub">{c.sub} · {fmtSize(c.bytes)}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="gauge-card">
          <StorageGauge
            totalBytes={totalBytes}
            segments={[
              { label: "Videos", bytes: videoBytes, color: "#1d4ed8" },
              { label: "Photos", bytes: imageBytes, color: "#7c3aed" },
              { label: "Other", bytes: otherBytes, color: "#b45309" },
            ]}
          />
          <div className="gauge-legend">
            <span><span className="legend-dot" style={{ background: "#1d4ed8" }} />Videos</span>
            <span><span className="legend-dot" style={{ background: "#7c3aed" }} />Photos</span>
            <span><span className="legend-dot" style={{ background: "#b45309" }} />Other</span>
          </div>
        </div>
      </div>
    </>
  );
}

function Library() {
  const [files, setFiles] = useState([]);
  const [allFiles, setAllFiles] = useState([]); // across all folders, for the storage overview
  const [folders, setFolders] = useState([]);
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [currentFolder, setCurrentFolder] = useState(null); // folder id or null (root)
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(null);
  const [shareInfo, setShareInfo] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const { addFilesWithPaths, addFiles } = useUploadContext();
  const folderUploadRef = useRef();

  const load = async () => {
    try {
      const qs = currentFolder ? `?folder_id=${currentFolder}` : "";
      const [filesRes, foldersRes, allRes] = await Promise.all([
        api(`/files${qs}`),
        api(`/folders${qs}`),
        api(`/files?all=1`),
      ]);
      setFiles(filesRes.files);
      setFolders(foldersRes.folders);
      setBreadcrumb(foldersRes.breadcrumb);
      setAllFiles(allRes.files);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 6000);
    return () => clearInterval(interval);
  }, [currentFolder]);

  const toggleShare = async (file) => {
    const newVisibility = file.visibility === "public" ? "private" : "public";
    try {
      const res = await api(`/files/${file.id}/share`, { method: "POST", body: JSON.stringify({ visibility: newVisibility }) });
      await load();
      if (res.shareUrl) {
        setShareInfo({ file, url: res.shareUrl });
        navigator.clipboard?.writeText(res.shareUrl).catch(() => {});
      } else {
        setShareInfo(null);
      }
    } catch (e) { setError(e.message); }
  };

  const deleteFile = async (file) => {
    if (!confirm(`Remove "${file.filename}" from ${APP_NAME}? (Stays in your Telegram Saved Messages.)`)) return;
    try {
      await api(`/files/${file.id}`, { method: "DELETE" });
      await load();
    } catch (e) { setError(e.message); }
  };

  const startRename = (file) => {
    setRenamingId(file.id);
    setRenameValue(file.filename);
  };

  const submitRename = async (file) => {
    if (!renameValue.trim() || renameValue === file.filename) { setRenamingId(null); return; }
    try {
      await api(`/files/${file.id}`, { method: "PATCH", body: JSON.stringify({ filename: renameValue.trim() }) });
      setRenamingId(null);
      await load();
    } catch (e) { setError(e.message); }
  };

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      await api("/folders", { method: "POST", body: JSON.stringify({ name: newFolderName.trim(), parent_id: currentFolder }) });
      setNewFolderName("");
      setNewFolderOpen(false);
      await load();
    } catch (e) { setError(e.message); }
  };

  const deleteFolder = async (folder) => {
    if (!confirm(`Delete empty folder "${folder.name}"?`)) return;
    try {
      await api(`/folders/${folder.id}`, { method: "DELETE" });
      await load();
    } catch (e) { setError(e.message); }
  };

  const handleFolderUpload = (fileList) => addFilesWithPaths(fileList, currentFolder);
  const handleFilesHere = (fileList) => addFiles(fileList, { folderId: currentFolder });

  const filtered = files.filter((f) => {
    if (search.trim() && !f.filename.toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (filter === "all") return true;
    if (filter === "video") return f.mimetype?.startsWith("video/");
    if (filter === "image") return f.mimetype?.startsWith("image/");
    if (filter === "other") return !f.mimetype?.startsWith("video/") && !f.mimetype?.startsWith("image/");
    return true;
  });

  return (
    <div className="page animate-in">
      <div className="card">
        <StorageOverview allFiles={allFiles} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} />

        <div className="breadcrumb" style={{ marginTop: 14 }}>
          <a onClick={() => setCurrentFolder(null)}>🏠 Root</a>
          {breadcrumb.map((b) => (
            <React.Fragment key={b.id}>
              <span className="sep">/</span>
              <a onClick={() => setCurrentFolder(b.id)}>{b.name}</a>
            </React.Fragment>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <button className="btn btn-sm" onClick={() => setNewFolderOpen((v) => !v)}>+ New folder</button>
          <button className="btn btn-sm" onClick={() => folderUploadRef.current.click()}><Icon src={ICON_URLS.folder} size={14} /> Upload folder here</button>
          <label className="btn btn-sm" style={{ cursor: "pointer" }}>
            <Icon src={ICON_URLS.upload} size={14} /> Upload files here
            <input type="file" multiple style={{ display: "none" }} onChange={(e) => e.target.files.length && handleFilesHere(e.target.files)} />
          </label>
          <input
            ref={folderUploadRef}
            type="file"
            webkitdirectory=""
            directory=""
            multiple
            style={{ display: "none" }}
            onChange={(e) => e.target.files.length && handleFolderUpload(e.target.files)}
          />
        </div>

        {newFolderOpen && (
          <div className="inline-edit" style={{ marginBottom: 16, maxWidth: 320 }}>
            <input
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createFolder()}
              autoFocus
            />
            <button className="btn btn-sm btn-primary" onClick={createFolder}>Create</button>
          </div>
        )}

        {error && <div className="error-box">{error}</div>}
        {shareInfo && (
          <div className="info-box">
            Link {shareInfo.file.visibility === "public" ? "copied to clipboard" : "removed"} for <strong>{shareInfo.file.filename}</strong>:
            {shareInfo.url && <div style={{ marginTop: 6 }}><a href={shareInfo.url} target="_blank" rel="noreferrer">{shareInfo.url}</a></div>}
          </div>
        )}

        {folders.length === 0 && filtered.length === 0 && <div className="empty-state">Nothing here yet.</div>}

        {folders.length > 0 && (
          <>
            <div className="section-label"><span><Icon src={ICON_URLS.folder} size={16} /> Folders</span></div>
            <div className="file-grid" style={{ marginBottom: 16 }}>
              {folders.map((folder) => (
                <div key={folder.id} className="folder-card" onClick={() => setCurrentFolder(folder.id)}>
                  <div className="folder-icon"><Icon src={ICON_URLS.folder} size={24} /></div>
                  <div className="folder-name">{folder.name}</div>
                  <button className="uw-icon-btn" onClick={(e) => { e.stopPropagation(); deleteFolder(folder); }}>✕</button>
                </div>
              ))}
            </div>
          </>
        )}

        {filtered.length > 0 && <div className="section-label"><span>🗂️ Files</span></div>}
        <div className="file-grid">
          {filtered.map((f) => {
            const isImage = f.mimetype?.startsWith("image/");
            return (
              <div className="file-card" key={f.id} onClick={() => renamingId !== f.id && setPlaying(f)}>
                {isImage ? (
                  <img className="file-card-thumb" src={apiUrl(`/files/${f.id}/stream`)} alt={f.filename} loading="lazy" />
                ) : (
                  <div className="file-card-icon"><FileTypeIcon mimetype={f.mimetype} /></div>
                )}
                {renamingId === f.id ? (
                  <div className="inline-edit" onClick={(e) => e.stopPropagation()}>
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && submitRename(f)}
                      autoFocus
                    />
                    <button className="btn btn-sm btn-primary" onClick={() => submitRename(f)}>✓</button>
                  </div>
                ) : (
                  <div className="file-card-name">{f.filename}</div>
                )}
                <div className="file-card-sub">{fmtSize(f.size)} · <span className={`badge ${f.visibility}`}>{f.visibility}</span></div>
                <div className="file-card-actions" onClick={(e) => e.stopPropagation()}>
                  <a className="btn btn-sm" href={apiUrl(`/files/${f.id}/stream?download=1`)} download={f.filename}>⬇ Download</a>
                  <button className="btn btn-sm" onClick={() => toggleShare(f)}>{f.visibility === "public" ? "Unshare" : "Share"}</button>
                  <button className="btn btn-sm" onClick={() => startRename(f)}>Rename</button>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteFile(f)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <PlayerModal file={playing} onClose={() => setPlaying(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public viewer
// ---------------------------------------------------------------------------
function PublicViewer({ token }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(apiUrl(`/public/${token}/info`))
      .then((r) => { if (!r.ok) throw new Error("This link is invalid, private, or has been removed."); return r.json(); })
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, [token]);

  const src = apiUrl(`/public/${token}`);
  const isVideo = info?.mimetype?.startsWith("video/");
  const isImage = info?.mimetype?.startsWith("image/");
  const isAudio = info?.mimetype?.startsWith("audio/");

  return (
    <div className="page animate-in">
      <div className="card public-page">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div className="brand" onClick={() => (window.location.href = "/")}>
            <div className="brand-badge">☁️</div>
            <span className="brand-shree">Shree</span><span className="brand-rest">CloudStorage</span>
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 13 }}>
            <a href="/">Home</a>
            <a href="/docs">Docs</a>
          </div>
        </div>

        {error && <div className="error-box">{error}</div>}
        {!error && !info && <p className="hint">Loading…</p>}
        {info && (
          <>
            <h3 style={{ wordBreak: "break-all" }}>{info.filename}</h3>
            <p className="hint">{fmtSize(info.size)}</p>
            {isVideo && <video src={src} controls style={{ width: "100%", borderRadius: 8, background: "black" }} />}
            {isAudio && <audio src={src} controls style={{ width: "100%" }} />}
            {isImage && <img src={src} alt={info.filename} style={{ width: "100%", borderRadius: 8 }} />}
            {!isVideo && !isAudio && !isImage && <p>Preview not available for this file type.</p>}
            <div style={{ marginTop: 16 }}>
              <a className="btn btn-primary" href={src} download={info.filename}>Download</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Docs page
// ---------------------------------------------------------------------------

// Developer API page — generate a free personal API key, docs for using it
// ---------------------------------------------------------------------------
function ApiKeysPage() {
  const [apiKey, setApiKey] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      const r = await api("/auth/api-key");
      setApiKey(r.apiKey);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, []);

  const generate = async () => {
    if (apiKey && !confirm("This replaces your existing key — anything using the old one will stop working. Continue?")) return;
    setLoading(true);
    setError("");
    try {
      const r = await api("/auth/api-key/generate", { method: "POST" });
      setApiKey(r.apiKey);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const copy = () => {
    navigator.clipboard?.writeText(apiKey).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="page animate-in">
      <div className="card">
        <h2 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 10 }}><Icon src={ICON_URLS.api} size={26} /> Developer API</h2>
        <p className="hint">
          Free personal API key — use it from your own scripts/projects to upload, list, and
          download files in your {APP_NAME} account, without opening the website.
        </p>

        {error && <div className="error-box">{error}</div>}

        {apiKey ? (
          <div className="inline-edit" style={{ maxWidth: 480 }}>
            <input readOnly value={apiKey} style={{ fontFamily: "monospace" }} />
            <button className="btn btn-sm" onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
          </div>
        ) : (
          <p className="hint">No API key yet — generate one below.</p>
        )}
        <button className="btn btn-primary btn-sm" onClick={generate} disabled={loading} style={{ marginTop: 8 }}>
          {loading ? "Working…" : apiKey ? "Regenerate key" : "Generate API key"}
        </button>

        <div className="tip-box" style={{ marginTop: 20 }}>
          ⚠️ Treat this key like a password — anyone with it can upload/read/delete files in your
          account via the API. Regenerating it immediately invalidates the old one.
        </div>

        <div className="section-label"><span>📚 Quick usage</span></div>
        <p className="hint">Upload a file:</p>
        <pre><code>{`curl -X POST "${API_BASE || "https://your-backend-url"}/api/v1/upload" \\
  -H "X-API-Key: ${apiKey || "YOUR_API_KEY"}" \\
  -F "file=@/path/to/video.mp4"`}</code></pre>
        <p className="hint">List your files:</p>
        <pre><code>{`curl "${API_BASE || "https://your-backend-url"}/api/v1/files" \\
  -H "X-API-Key: ${apiKey || "YOUR_API_KEY"}"`}</code></pre>
        <p className="hint">Download/stream a file (supports Range requests):</p>
        <pre><code>{`curl "${API_BASE || "https://your-backend-url"}/api/v1/files/FILE_ID/stream" \\
  -H "X-API-Key: ${apiKey || "YOUR_API_KEY"}" -o downloaded.mp4`}</code></pre>
        <p className="hint">Full endpoint reference is on the <a onClick={() => navigate("/docs")}>Docs</a> page.</p>
      </div>
    </div>
  );
}


function BackupAccountSection() {
  const [status, setStatus] = useState(null); // {hasBackup, backupPhone, backupEnabled}
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Add-backup phone-code flow (same shape as the main login form)
  const [phone, setPhone] = useState("");
  const [requestId, setRequestId] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);

  const load = async () => {
    try {
      const r = await api("/auth/backup/status");
      setStatus(r);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, []);

  const sendCode = async () => {
    setLoading(true);
    setError("");
    try {
      const { requestId } = await api("/auth/backup/send-code", { method: "POST", body: JSON.stringify({ phone }) });
      setRequestId(requestId);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const verify = async () => {
    setLoading(true);
    setError("");
    try {
      await api("/auth/backup/verify-code", {
        method: "POST",
        body: JSON.stringify({ requestId, code, password: needsPassword ? password : undefined }),
      });
      setRequestId(null); setCode(""); setPassword(""); setNeedsPassword(false); setPhone("");
      await load();
    } catch (e) {
      if (e.message === "2FA_PASSWORD_REQUIRED") setNeedsPassword(true);
      else setError(e.message);
    }
    setLoading(false);
  };

  const toggle = async (enabled) => {
    setError("");
    try {
      await api("/auth/backup/toggle", { method: "POST", body: JSON.stringify({ enabled }) });
      await load();
    } catch (e) { setError(e.message); }
  };

  const remove = async () => {
    if (!confirm("Remove your backup account? Files already backed up will stay in that account's Saved Messages, but new uploads will stop being mirrored there.")) return;
    setError("");
    try {
      await api("/auth/backup/remove", { method: "POST" });
      await load();
    } catch (e) { setError(e.message); }
  };

  if (!status) return null;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>🛡️ Backup Account</h2>
      <p className="hint">
        Add a second Telegram account. When enabled, every file you upload is mirrored there too —
        a safety copy in case your main account is ever lost or suspended. Sharing and streaming
        always use your <strong>main</strong> account; the backup is just a redundant copy.
      </p>
      {error && <div className="error-box">{error}</div>}

      {status.hasBackup ? (
        <>
          <div className="backup-status-row">
            <div>
              <div style={{ fontWeight: 600 }}>{status.backupPhone}</div>
              <div className="hint" style={{ margin: 0 }}>Backup account connected</div>
            </div>
            <label className="switch">
              <input type="checkbox" checked={status.backupEnabled} onChange={(e) => toggle(e.target.checked)} />
              <span className="switch-track"><span className="switch-thumb" /></span>
            </label>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            {status.backupEnabled ? "✅ Backups are ON — new uploads mirror to this account too." : "⏸️ Backups are OFF — uploads only go to your main account right now."}
          </p>
          <button className="btn btn-sm btn-danger" onClick={remove} style={{ marginTop: 8 }}>Remove backup account</button>
        </>
      ) : (
        <>
          {!requestId && (
            <>
              <p className="hint">Enter the phone number of the Telegram account you want to use as backup (must be different from your main account).</p>
              <input className="field" placeholder="+1 234 567 8900" value={phone}
                onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendCode()} />
              <button className="btn btn-primary btn-sm" onClick={sendCode} disabled={loading || !phone}>
                {loading ? "Sending…" : "Send Code"}
              </button>
            </>
          )}
          {requestId && (
            <>
              <p className="hint">Check that account's Telegram app for the login code.</p>
              <input className="field" placeholder="Login code" value={code}
                onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && verify()} />
              {needsPassword && (
                <input className="field" placeholder="2FA password" type="password" value={password}
                  onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && verify()} />
              )}
              <button className="btn btn-primary btn-sm" onClick={verify} disabled={loading || !code}>
                {loading ? "Verifying…" : "Verify & Add"}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

function SettingsPage() {
  return (
    <div className="page animate-in">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Settings</h2>
        <p className="hint">Manage your account safety net and preferences.</p>
      </div>
      <BackupAccountSection />
    </div>
  );
}


function Callout({ type = "info", children }) {
  const icons = { info: "ℹ️", tip: "💡", warning: "⚠️", success: "✅", danger: "🚫" };
  return (
    <div className={`callout callout-${type}`}>
      <span className="callout-icon">{icons[type] || icons.info}</span>
      <div>{children}</div>
    </div>
  );
}

function FeatureCard({ icon, title, desc }) {
  return (
    <div className="docs-feature-card">
      <div className="docs-feature-icon">{icon}</div>
      <div className="docs-feature-title">{title}</div>
      <div className="docs-feature-desc">{desc}</div>
    </div>
  );
}

function ApiEndpoint({ method, path, desc }) {
  const methodClass = { GET: "get", POST: "post", DELETE: "delete", PATCH: "patch" }[method] || "get";
  return (
    <div className="api-endpoint">
      <div className="api-endpoint-head">
        <span className={`api-method api-method-${methodClass}`}>{method}</span>
        <code className="api-path">{path}</code>
      </div>
      <p className="api-endpoint-desc">{desc}</p>
    </div>
  );
}

function CodeTabs({ tabs }) {
  const langs = Object.keys(tabs);
  const [active, setActive] = useState(langs[0]);
  return (
    <div className="code-tabs">
      <div className="code-tabs-bar">
        {langs.map((l) => (
          <button key={l} className={"code-tab" + (active === l ? " active" : "")} onClick={() => setActive(l)}>{l}</button>
        ))}
      </div>
      <CodeBlock lang={active}>{tabs[active]}</CodeBlock>
    </div>
  );
}

function CodeBlock({ children, lang }) {
  const [copied, setCopied] = useState(false);
  const code = Array.isArray(children) ? children.join("") : children;

  const copy = () => {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{lang || "text"}</span>
        <button className="code-block-copy" onClick={copy}>{copied ? "✓ Copied" : "Copy"}</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function Docs() {
  // Sidebar is grouped into categories (per the requested premium-docs
  // layout). Every id below maps to an existing <h2 id="..."> further down —
  // no content was removed, this is purely a navigation/presentation layer
  // on top of the same documentation text as before.
  const DOC_GROUPS = [
    { group: "Getting Started", icon: "🚀", items: [
      { id: "overview", label: "Overview" },
      { id: "why-us", label: "Why ShreeCloudStorage" },
      { id: "tech-stack", label: "Tech Stack" },
      { id: "quickstart", label: "Quick Start" },
    ]},
    { group: "Storage", icon: "📁", items: [
      { id: "folders", label: "Folders" },
      { id: "multi-upload", label: "Multi Upload" },
      { id: "rename", label: "Rename" },
      { id: "cancel", label: "Cancel Upload" },
      { id: "sharing", label: "Sharing" },
      { id: "speed", label: "Upload Speed" },
      { id: "resumable-uploads", label: "Resumable Uploads" },
    ]},
    { group: "Account", icon: "👤", items: [
      { id: "qr-login", label: "QR Login" },
      { id: "profile", label: "Profile" },
      { id: "backup-account", label: "Backup Account" },
    ]},
    { group: "Developer", icon: "⚙️", items: [
      { id: "api", label: "API Overview" },
      { id: "api-auth", label: "Authentication" },
      { id: "api-ratelimits", label: "Rate Limits" },
    ]},
    { group: "Security & Admin", icon: "🛡️", items: [
      { id: "security-tips", label: "Security Tips" },
      { id: "admin", label: "Admin Panel" },
    ]},
    { group: "More", icon: "💛", items: [
      { id: "how-it-works", label: "How It Works" },
      { id: "github", label: "GitHub & Community" },
      { id: "credits", label: "Credits" },
    ]},
  ];
  const FLAT_SECTIONS = DOC_GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })));

  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeId, setActiveId] = useState("overview");
  const [progress, setProgress] = useState(0);
  const [showBackToTop, setShowBackToTop] = useState(false);

  const goTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setMobileSidebarOpen(false);
    setSearchOpen(false);
    setSearchQuery("");
  };

  // Ctrl+K / Cmd+K opens search; Escape closes it.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "Escape") {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reading progress + scroll-spy for the right-hand "On this page" panel.
  useEffect(() => {
    const onScroll = () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(docHeight > 0 ? Math.min(100, Math.round((scrollTop / docHeight) * 100)) : 0);
      setShowBackToTop(scrollTop > 600);

      let current = FLAT_SECTIONS[0]?.id;
      for (const s of FLAT_SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top - 120 <= 0) current = s.id;
      }
      setActiveId(current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const searchResults = searchQuery.trim()
    ? FLAT_SECTIONS.filter((s) => s.label.toLowerCase().includes(searchQuery.toLowerCase()) || s.group.toLowerCase().includes(searchQuery.toLowerCase()))
    : FLAT_SECTIONS;

  const toggleGroup = (g) => setCollapsedGroups((c) => ({ ...c, [g]: !c[g] }));

  const SidebarNav = () => (
    <nav className="docs-sidebar-nav">
      {DOC_GROUPS.map((g) => (
        <div key={g.group} className="docs-nav-group">
          <button className="docs-nav-group-header" onClick={() => toggleGroup(g.group)}>
            <span>{g.icon} {g.group}</span>
            <span className={"docs-nav-chevron" + (collapsedGroups[g.group] ? " collapsed" : "")}>▾</span>
          </button>
          {!collapsedGroups[g.group] && (
            <div className="docs-nav-items">
              {g.items.map((it) => (
                <a
                  key={it.id}
                  className={"docs-nav-item" + (activeId === it.id ? " active" : "")}
                  onClick={() => goTo(it.id)}
                >
                  {it.label}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="page animate-in docs-page">
      <div className="docs-progress-bar"><div className="docs-progress-fill" style={{ width: `${progress}%` }} /></div>

      <div className="docs-toolbar">
        <button className="btn btn-sm docs-sidebar-toggle" onClick={() => setMobileSidebarOpen((v) => !v)}>
          ☰ Sections
        </button>
        <button className="docs-search-trigger" onClick={() => setSearchOpen(true)}>
          🔍 <span>Search docs…</span> <kbd>Ctrl K</kbd>
        </button>
      </div>

      <div className="docs-shell">
        {/* Left sidebar — desktop sticky, mobile drawer */}
        <aside className={"docs-sidebar" + (mobileSidebarOpen ? " open" : "")}>
          <SidebarNav />
        </aside>
        {mobileSidebarOpen && <div className="docs-sidebar-scrim" onClick={() => setMobileSidebarOpen(false)} />}

        <div className="docs-content docs-content-premium">

          {/* ============ PREMIUM HERO ============ */}
          <div className="docs-hero">
            <span className="docs-hero-badge">🟢 Open Source</span>
            <h1 className="docs-hero-title">Unlimited Telegram Cloud Storage</h1>
            <p className="docs-hero-subtitle">
              {APP_NAME} turns your own Telegram account into free, effectively unlimited cloud
              storage — upload, stream, and share files of any size, backed by your own Saved Messages.
            </p>
            <div className="docs-hero-pills">
              {["Unlimited Storage", "Streaming", "Public Sharing", "API Access", "QR Login"].map((p) => (
                <span key={p} className="docs-hero-pill">{p}</span>
              ))}
            </div>
            <div className="docs-hero-actions">
              <button className="btn btn-primary" onClick={() => navigate("/login")}>Get Started</button>
              <a className="btn" href={GITHUB_REPO} target="_blank" rel="noreferrer">⭐ GitHub</a>
            </div>
          </div>

          <h2 id="overview">Overview</h2>
          <p>
            {APP_NAME} turns your own Telegram account into free, effectively unlimited cloud
            storage. Files upload straight to your Telegram <strong>Saved Messages</strong>,
            stream back with full seek support, and can be shared publicly or kept private —
            without your files ever sitting on our server disk.
          </p>

          <h2 id="why-us">Why {APP_NAME}?</h2>
          <Callout type="tip">
            No storage caps, no "upgrade for more space" paywalls, no per-GB pricing — your
            limit is your own Telegram account's, which for most people is effectively unlimited.
          </Callout>
          <div className="docs-feature-grid">
            <FeatureCard icon="♾️" title="Genuinely free, genuinely unlimited" desc="There's no hidden tier where the real storage lives behind a paywall." />
            <FeatureCard icon="🔒" title="Your data, your account" desc="Files live in your own Telegram Saved Messages, not a black-box server you have to trust blindly." />
            <FeatureCard icon="▶️" title="Real streaming, not just downloads" desc="Video and audio play instantly with seeking, even for large files." />
            <FeatureCard icon="⚡" title="Upload and keep moving" desc="Background uploads with live speed, multiple files at once, whole folders at once." />
            <FeatureCard icon="🔌" title="Built for developers too" desc="A free API key means your own apps and scripts can plug straight in." />
          </div>

          <h2 id="tech-stack">Tech stack (high level)</h2>
          <p>For the curious — here's what powers {APP_NAME}, at a high level:</p>
          <div className="docs-tech-grid">
            {[
              ["⚛️", "React (Vite)"], ["🟩", "Node.js"], ["🚂", "Express"],
              ["✈️", "Telegram MTProto"], ["🗄️", "Embedded JSON DB"], ["🛡️", "Helmet + rate limiting"],
            ].map(([icon, label]) => (
              <div key={label} className="docs-tech-card"><span className="docs-tech-icon">{icon}</span><span>{label}</span></div>
            ))}
          </div>
          <ul>
            <li><strong>Frontend:</strong> React (Vite), plain CSS with theme variables (light/dark), deployed on Vercel.</li>
            <li><strong>Backend:</strong> Node.js + Express, deployed on Railway.</li>
            <li><strong>Telegram integration:</strong> MTProto (the same protocol the real Telegram apps use) via a GramJS-based client library — this is what allows large files and real user-account login, unlike the more limited Bot API.</li>
            <li><strong>Metadata storage:</strong> a lightweight embedded JSON database for file/folder/user records — the files themselves are never stored on our servers, only on Telegram.</li>
            <li><strong>Security middleware:</strong> standard hardening (security headers, rate limiting) on top of Express.</li>
            <li><strong>Realtime progress:</strong> Server-Sent Events for live upload speed, and QR-code login via Telegram's real login-token flow.</li>
          </ul>
          <p className="hint">(We keep this section intentionally high-level rather than naming internal functions/files — enough to satisfy curiosity without handing out a map of the internals.)</p>

          <h2 id="quickstart">Quickstart</h2>
          <div className="docs-timeline">
            {[
              ["1", "Log in", "Enter your Telegram phone number or scan a QR code."],
              ["2", "Upload", "Drop in a file, several at once, or a whole folder."],
              ["3", "Stream", "Play video/audio instantly, with full seeking."],
              ["4", "Share", "Toggle a file public to get a link, or keep it private."],
              ["5", "Done", "Your file lives safely in your own Telegram Saved Messages."],
            ].map(([n, t, d]) => (
              <div key={n} className="docs-timeline-step">
                <div className="docs-timeline-num">{n}</div>
                <div>
                  <div className="docs-timeline-title">{t}</div>
                  <div className="docs-timeline-desc">{d}</div>
                </div>
              </div>
            ))}
          </div>
          <p>Backend:</p>
          <CodeBlock lang="bash">{`cd backend
cp .env.example .env   # add TG_API_ID, TG_API_HASH, two random secrets
npm install
npm start`}</CodeBlock>
          <p>Frontend:</p>
          <CodeBlock lang="bash">{`cd frontend
npm install
npm run dev`}</CodeBlock>
          <Callout type="info">Tip: get <code>TG_API_ID</code>/<code>TG_API_HASH</code> free at my.telegram.org — takes under 2 minutes.</Callout>

          <h2 id="how-it-works">How it works</h2>
          <p>
            Login uses Telegram's real MTProto protocol (via the <code>telegram</code> / GramJS
            library) — the same flow the official Telegram apps use — instead of the Bot API,
            which caps downloads at 20MB. That's why large videos work here.
          </p>
          <CodeBlock lang="js">{`await client.sendFile("me", {
  file: fileBuffer,
  workers: 16,           // 16 parallel parts = faster upload
  progressCallback: onProgress,
});`}</CodeBlock>

          <h2 id="qr-login">QR code login</h2>
          <p>
            Prefer not to type a code? Switch to <strong>"Log in with QR code"</strong> on the
            login page. Open Telegram on your phone → Settings → Devices → Link Desktop Device,
            and scan the code shown — login completes automatically the moment it's scanned, no
            typing required. Works the same as linking a new device in the official Telegram app.
          </p>

          <h2 id="profile">Your profile</h2>
          <p>
            Once logged in, the nav bar shows your real Telegram name and profile photo — pulled
            live from your account, not stored separately. Your username is intentionally not
            shown here.
          </p>

          <h2 id="backup-account">Backup account</h2>
          <p>
            From <a onClick={() => navigate("/settings")}>Settings</a>, you can add a second
            Telegram account as a backup. When it's turned on, every file you upload is
            automatically mirrored to that account's Saved Messages too — a safety copy in case
            your main account is ever lost, banned, or suspended.
          </p>
          <ul>
            <li>Sharing and streaming always use your <strong>main</strong> account's copy — the backup is never exposed on its own, it's purely a redundant safety copy.</li>
            <li>Adding a backup account uses the same phone-number + code login as your main account, just for a different Telegram account.</li>
            <li>You can turn backup mirroring on/off at any time — turning it off just stops <em>new</em> uploads from being mirrored; anything already backed up stays where it is.</li>
            <li>Mirroring is best-effort: if the backup upload fails for any reason, your main upload still succeeds normally — a backup hiccup never blocks or breaks what you're actually waiting on.</li>
          </ul>
          <Callout type="tip">Removing a backup account only disconnects it from future uploads — it does not delete anything already saved there.</Callout>

          <h2 id="folders">Folders</h2>
          <p>
            Create folders from the Library page, navigate into them, and upload directly
            inside one. You can also upload an entire folder from your computer at once — the
            folder structure is recreated automatically on the server side from each file's
            relative path.
          </p>

          <h2 id="rename">Renaming files</h2>
          <p>
            Renaming a file updates it in <strong>both</strong> places: your local database and
            the actual Telegram message caption in Saved Messages (via <code>messages.EditMessage</code>),
            so the name stays consistent whether you view it here or directly in Telegram.
          </p>

          <h2 id="multi-upload">Multiple files & background uploads</h2>
          <p>
            The Upload page accepts multiple files at once. Upload progress lives in a floating
            tray in the corner, not tied to any single page, so you can navigate anywhere else
            on the site while uploads keep running. Minimize it to a slim strip, or enlarge it
            to see every file's status at once.
          </p>

          <h2 id="cancel">Cancelling an upload</h2>
          <p>
            Each in-progress upload has a ✕ button. If it's still in the browser→server leg,
            cancelling is instant. If it has already moved into the server→Telegram leg, cancel
            is best-effort: the server force-disconnects that upload's Telegram connection,
            which stops the transfer, and a fresh connection is made automatically next time.
          </p>

          <h2 id="sharing">Sharing</h2>
          <p>
            Toggling a file to <strong>public</strong> generates a random share token and a link
            at <code>/public/&lt;token&gt;</code>, viewable with no login. Toggle back to{" "}
            <strong>private</strong> any time to revoke it.
          </p>
          <Callout type="warning">
            If a share link doesn't load: check <code>PUBLIC_BASE_URL</code> in your backend's{" "}
            <code>.env</code> points at your frontend's real address, not the backend port.
          </Callout>

          <h2 id="speed">Upload speed</h2>
          <p>
            Uploads have two legs: browser → our server (fast) and our server → Telegram (the
            real bottleneck). Live speed/ETA shown is driven by GramJS's actual{" "}
            <code>progressCallback</code> during the real Telegram upload, streamed to the
            browser over Server-Sent Events — not a guess based on the fast local leg.
          </p>
          <p>
            Files up to 20MB are uploaded straight from memory, no disk involved at all. Files
            larger than that are written to a short-lived temp file first — this isn't our
            choice, it's a hard requirement in the underlying Telegram library for large
            transfers, and the temp file is deleted immediately once the upload finishes.
          </p>

          <h2 id="resumable-uploads">Resumable uploads</h2>
          <p>
            Files upload in small chunks (4MB each) instead of one single request. If your
            internet drops mid-upload, only that one in-flight chunk is affected — the upload
            shows <strong>"⏸ Paused — waiting for connection…"</strong> instead of failing or
            cancelling. The moment your connection comes back, it automatically resumes from the
            exact byte where it left off, at whatever speed is currently available. Nothing is
            lost and nothing needs to be restarted from zero.
          </p>
          <Callout type="tip">
            This works as long as the browser tab stays open. Closing the tab or navigating away
            from the site entirely does end the upload — the resumability is for network
            interruptions, not for closing the app mid-upload.
          </Callout>

          <h2 id="admin">Admin panel</h2>
          <p>
            A separate monitoring dashboard lives at <code>/admin</code>, with its own login
            (kept fully independent from user auth). It shows <strong>metadata</strong> — user
            count, storage used per account, file counts, last-active times, and a full file
            listing. It never decrypts or displays a user's Telegram session string, because
            that string is equivalent to a live login to their real Telegram account — no admin
            panel should be able to read or reuse it.
          </p>
          <p>
            Phone numbers are <strong>masked by default</strong> in the Users tab (e.g.{" "}
            <code>+91••••89</code>). To see a full, unmasked number, the admin re-enters the
            admin password — this is checked fresh every time and isn't a setting that stays
            toggled on, so unmasked numbers are only ever shown in direct response to that
            confirmation, not left exposed for the rest of the session.
          </p>
          <p>
            A <strong>Traffic &amp; Bans</strong> tab tracks every visitor by IP: unique visitors,
            total requests, today's requests, a 14-day request graph, and a per-IP table with
            request counts and first/last-seen times. Any IP can be banned with one click — a
            banned IP gets an immediate 403 on every request to the site, before any route even
            runs. (The admin's own active session is exempted from bans, so an accidental
            self-ban can't lock the panel out from itself.)
          </p>
          <Callout type="warning">
            Default admin credentials are set via <code>ADMIN_ID</code>/<code>ADMIN_PASSWORD</code>{" "}
            in <code>backend/.env</code>. Change the password before deploying this anywhere
            public — a hardcoded/default admin login is a real risk if the source is ever shared.
          </Callout>

          <h2 id="api">Developer API</h2>
          <p>
            Every logged-in user can generate a free personal API key from the{" "}
            <a onClick={() => navigate("/api")}>API page</a> and call these endpoints directly
            from their own projects — no OAuth flow, just a header.
          </p>

          <ApiEndpoint
            method="POST"
            path="/api/v1/upload"
            desc={<>Upload a file. Multipart field <code>file</code>. Files are <strong>public and shareable by default</strong> — the response already includes a working <code>shareUrl</code>, no extra step needed on the website. Add <code>?public=0</code> if you want the file to stay private instead.</>}
          />
          <ApiEndpoint method="GET" path="/api/v1/files" desc="List every file in your account." />
          <ApiEndpoint method="GET" path="/api/v1/files/:id" desc="Metadata for a single file." />
          <ApiEndpoint method="GET" path="/api/v1/files/:id/stream" desc="Download/stream a file. Supports HTTP Range requests for seeking." />
          <ApiEndpoint method="DELETE" path="/api/v1/files/:id" desc="Delete a file from your account." />

          <h3 id="api-auth" style={{ marginTop: 28 }}>Authentication</h3>
          <p>Send your key with either header — both are accepted:</p>
          <CodeTabs
            tabs={{
              cURL: `curl -H "X-API-Key: tc_xxxxxxxxxxxxxxxxxxxx" \\
  ${API_BASE || "https://your-backend-url"}/api/v1/files`,
              "Node.js": `fetch("${API_BASE || "https://your-backend-url"}/api/v1/files", {
  headers: { "X-API-Key": "tc_xxxxxxxxxxxxxxxxxxxx" }
});`,
              Python: `import requests
requests.get(
    "${API_BASE || "https://your-backend-url"}/api/v1/files",
    headers={"X-API-Key": "tc_xxxxxxxxxxxxxxxxxxxx"}
)`,
            }}
          />

          <h3 id="api-ratelimits" style={{ marginTop: 28 }}>Rate limits</h3>
          <table className="docs-table">
            <thead><tr><th>Endpoint group</th><th>Limit</th></tr></thead>
            <tbody>
              <tr><td>Phone-code login (send/verify)</td><td>20 requests / 15 min per IP</td></tr>
              <tr><td>QR login start</td><td>60 requests / 15 min per IP</td></tr>
              <tr><td>Developer API (<code>/api/v1/*</code>)</td><td>60 requests / minute per IP</td></tr>
            </tbody>
          </table>
          <Callout type="tip">The API is free to use. It shares the same rate limits and underlying Telegram storage as the website — there's no separate quota.</Callout>

          <h2 id="security-tips">Security tips</h2>
          <ul>
            <li>The encrypted session stored per user is equivalent to a live Telegram login — protect <code>SESSION_ENCRYPT_KEY</code> like a database credential.</li>
            <li>Never commit your real <code>.env</code> file or paste API credentials into public chats/issues.</li>
            <li>Add retry/backoff for Telegram's <code>FLOOD_WAIT</code> errors if you scale to many concurrent uploads.</li>
            <li>Consider a secondary login method — losing Telegram access currently means losing {APP_NAME} access too.</li>
            <li>The backend ships with <code>helmet</code> (security headers, including HSTS to force HTTPS on repeat visits), a general site-wide rate limit (300 req/min per IP) on top of the stricter per-route limits (login, QR, API), and an Origin-check on all state-changing requests as CSRF mitigation. No public web app can be made 100% "unscrapable," but this closes the easy attack surface.</li>
            <li>The <a onClick={() => navigate("/admin")}>admin panel</a> can ban any IP outright — a banned IP gets a 403 on every request, before any route even runs. Useful for cutting off abusive traffic at scale.</li>
            <li>The admin panel's <strong>Request Logs</strong> tab shows a live, per-request log (time, path, method, status, latency, IP, country) with a "Request Inspector" for any entry — response body preview, full request/response details, and a copyable cURL command to replay it yourself. Logs are kept in memory only (most recent 2000 requests), and sensitive fields (passwords, codes, session data) are always redacted before being stored, even in this internal view.</li>
            <li><code>robots.txt</code> discourages well-behaved crawlers from indexing private routes — it does not stop a determined scraper, since anything a browser can render can eventually be fetched too.</li>
          </ul>

          <h2 id="github">Source & Development</h2>
          <p>
            Full source is on GitHub: <a href={GITHUB_REPO} target="_blank" rel="noreferrer">{GITHUB_REPO}</a>.
            Clone it, open issues, or submit pull requests there.
          </p>
          <ul>
            <li>Discuss or follow updates on Telegram: <a href={TG_CHANNEL_2} target="_blank" rel="noreferrer">t.me/shreeapi</a> and <a href={TG_CHANNEL_1} target="_blank" rel="noreferrer">t.me/nepalimomoswala</a>.</li>
            <li>Add a <code>.env.example</code> (already included) — never commit real secrets.</li>
            <li>Consider a "Deploy" button (Render/Railway/Fly.io) once you've added persistent storage beyond the local JSON db.</li>
          </ul>

          <h2 id="credits">Credits</h2>
          <p>{APP_NAME} — Powered by <strong>ShreeAPI</strong> · Designed by <strong>AnshAPI</strong>.</p>
        </div>

        {/* Right sidebar — "On This Page" with scroll-spy */}
        <aside className="docs-right-toc">
          <div className="docs-right-toc-label">On this page</div>
          {FLAT_SECTIONS.map((s) => (
            <a key={s.id} className={"docs-right-toc-item" + (activeId === s.id ? " active" : "")} onClick={() => goTo(s.id)}>
              {s.label}
            </a>
          ))}
        </aside>
      </div>

      {showBackToTop && (
        <button className="docs-back-to-top" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>↑ Top</button>
      )}

      {searchOpen && (
        <div className="docs-search-overlay" onClick={() => setSearchOpen(false)}>
          <div className="docs-search-modal" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="docs-search-input"
              placeholder="Search pages, features, API…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <div className="docs-search-results">
              {searchResults.map((s) => (
                <div key={s.id} className="docs-search-result" onClick={() => goTo(s.id)}>
                  <span className="hint" style={{ margin: 0 }}>{s.group}</span>
                  <span>{s.label}</span>
                </div>
              ))}
              {searchResults.length === 0 && <div className="hint" style={{ padding: 10 }}>No matches.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const path = useRoute();
  const [loggedIn, setLoggedIn] = useState(null);
  const [theme, setTheme] = useTheme();
  const uploadManager = useUploadManager();

  useEffect(() => {
    api("/auth/me").then((r) => setLoggedIn(r.loggedIn));
  }, []);

  useEffect(() => {
    if (loggedIn === true && path === "/login") navigate("/library");
    if (loggedIn === false && ["/upload", "/library", "/api", "/settings"].includes(path)) navigate("/login");
  }, [loggedIn, path]);

  const publicMatch = path.match(/^\/public\/([^/]+)/);
  const isAdminRoute = path === "/admin";

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    setLoggedIn(false);
    navigate("/");
  };

  if (isAdminRoute) {
    return (
      <>
        <BubbleBackground />
        <div className="app-shell">
          <AdminPanel />
        </div>
      </>
    );
  }

  let body;
  if (publicMatch) body = <PublicViewer token={publicMatch[1]} />;
  else if (path === "/login") body = <LoginForm onLoggedIn={() => setLoggedIn(true)} />;
  else if (path === "/upload") body = loggedIn ? <UploadPage /> : null;
  else if (path === "/library") body = loggedIn ? <Library /> : null;
  else if (path === "/api") body = loggedIn ? <ApiKeysPage /> : null;
  else if (path === "/settings") body = loggedIn ? <SettingsPage /> : null;
  else if (path === "/docs") body = <Docs />;
  else body = <Landing />;

  return (
    <UploadContext.Provider value={uploadManager}>
      <BubbleBackground />
      <div className="app-shell">
        {!publicMatch && <NavBar loggedIn={!!loggedIn} onLogout={logout} path={path} theme={theme} setTheme={setTheme} />}
        {body}
        {!publicMatch && <Footer />}
      </div>
      <UploadWidget />
    </UploadContext.Provider>
  );
}
