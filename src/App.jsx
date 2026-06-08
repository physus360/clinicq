/**
 * ClinicQ — Hospital Queue Management System
 * Firebase Firestore backend · All 4 portals · Chime · Audit Log · Session Stats
 *
 * SETUP:
 *   1. Create a Firebase project at https://console.firebase.google.com
 *   2. Enable Firestore in Native mode
 *   3. Replace the firebaseConfig object below with your project's config
 *   4. Firestore rules (development — tighten for production):
 *        rules_version = '2';
 *        service cloud.firestore {
 *          match /databases/{database}/documents {
 *            match /{document=**} { allow read, write: if true; }
 *          }
 *        }
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  doc,
  onSnapshot,
  setDoc,
  getDoc,
  deleteDoc,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  getDocs,
  serverTimestamp,
  Timestamp,
  where,
} from "firebase/firestore";
import { db, storage, APP_URL } from "./firebase.js";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { initCredentials, verifyLogin, changePassword, addRoomCredential, removeRoomCredential, fetchCredentials, onAuthChange, logout as logout_, signInWithGoogle, completeGoogleRedirect } from "./auth.js";

const CONFIG_DOC = doc(db, "clinicq", "config");
const ROOMS_COL = collection(db, "clinicq_rooms");
const AUDIT_COL = collection(db, "clinicq_audit");
const SESSIONS_COL = collection(db, "clinicq_sessions");

const roomDoc = (id) => doc(db, "clinicq_rooms", id);

// Per-room operational fields (live in clinicq_rooms/{id})
const ROOM_FIELDS = ["assigned", "sessions", "nowServing", "upNext", "customCall", "status"];
// Config fields (live in clinicq/config)
const CONFIG_FIELDS = ["rooms", "doctorDirectory", "chime", "schedule"];

/* ─────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────── */
const APP_VERSION = "2.0";
const CLINIC_NAME = "Noosandha Clinic";
const LOGO_PATH = "clinicq/logo";
const SPLASH_PATH = "clinicq/splash";

const DEFAULT_ROOMS = ["R01", "R02", "R03", "R04", "R05"];

const DEFAULT_SCHEDULE = {
  openTime: "08:00",   // splash → live queue
  closeTime: "17:00",  // live queue → splash
  clearTime: "06:00",  // auto-clear yesterday's tokens
  enabled: true,       // master toggle for the splash/schedule feature
};

const DEFAULT_STATE = {
  rooms: DEFAULT_ROOMS,
  assigned: {},       // roomId → { id, name, department }
  sessions: {},       // roomId → { startedAt, tokenStart } | null
  nowServing: {},     // roomId → number | null
  upNext: {},         // roomId → number | null
  customCall: {},     // roomId → string | null
  status: {},         // roomId → "IDLE"|"SESSION STARTED"|"CALLING"|"PAUSED"|"RECALL"|"SESSION ENDED"
  doctorDirectory: {},// id → { id, name, specialty, active }
  schedule: DEFAULT_SCHEDULE,
  chime: {
    enabled: true,
    volume: 0.22,
    doNotDisturb: false,
    dndStart: "22:00",
    dndEnd: "07:00",
    minGapSec: 3,
  },
};

/* ─────────────────────────────────────────────
   FIREBASE HELPERS — config + per-room split
───────────────────────────────────────────── */
// Write shared config (room list, doctor directory, chime)
async function pushConfig(config) {
  const payload = {};
  CONFIG_FIELDS.forEach((f) => { if (config[f] !== undefined) payload[f] = config[f]; });
  await setDoc(CONFIG_DOC, payload, { merge: true });
}

// Write a single room's operational data — only touches clinicq_rooms/{id}
async function pushRoom(roomId, roomData) {
  const payload = {};
  ROOM_FIELDS.forEach((f) => {
    payload[f] = roomData[f] !== undefined ? roomData[f] : null;
  });
  await setDoc(roomDoc(roomId), payload, { merge: true });
}

async function deleteRoomDoc(roomId) {
  try { await deleteDoc(roomDoc(roomId)); } catch {}
}

async function logAudit(entry) {
  try {
    await addDoc(AUDIT_COL, { ...entry, ts: serverTimestamp() });
  } catch {}
}

/* ─────────────────────────────────────────────
   CHIME HOOK
───────────────────────────────────────────── */
function useChime(settings) {
  const ctxRef = useRef(null);
  const lastRef = useRef(0);

  useEffect(() => {
    const prime = () => {
      if (!ctxRef.current) {
        try { ctxRef.current = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
      }
    };
    window.addEventListener("click", prime, { once: true });
    window.addEventListener("keydown", prime, { once: true });
  }, []);

  const inQuiet = () => {
    if (!settings) return false;
    if (settings.doNotDisturb) return true;
    const toMin = (s) => { const [h, m] = (s || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
    const S = toMin(settings.dndStart), E = toMin(settings.dndEnd);
    const now = new Date(); const cur = now.getHours() * 60 + now.getMinutes();
    if (S === E) return false;
    return S < E ? cur >= S && cur < E : cur >= S || cur < E;
  };

  return useCallback((type = "CALL", opts = {}) => {
    if (!settings?.enabled) return;
    if (!opts.force && inQuiet()) return;
    const now = Date.now();
    if (!opts.force && now - lastRef.current < (settings?.minGapSec ?? 3) * 1000) return;
    lastRef.current = now;
    try {
      if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = ctxRef.current;
      const vol = ctx.createGain();
      vol.gain.value = settings?.volume ?? 0.22;
      vol.connect(ctx.destination);
      const beep = (t, f, dur = 0.14) => {
        const o = ctx.createOscillator();
        o.type = "sine"; o.frequency.value = f;
        o.connect(vol); o.start(t); o.stop(t + dur);
      };
      const t0 = ctx.currentTime + 0.01;
      if (type === "RECALL") { beep(t0, 980); beep(t0 + 0.22, 1100); beep(t0 + 0.44, 980); }
      else if (type === "END") { beep(t0, 660); beep(t0 + 0.22, 550); }
      else { beep(t0, 880); beep(t0 + 0.22, 1046); }
    } catch {}
  }, [settings]);
}

/* ─────────────────────────────────────────────
   SHARED STATE HOOK — reads config + all room docs,
   merges into the same in-memory shape the portals expect.
───────────────────────────────────────────── */
function useClinicState() {
  const [config, setConfig] = useState({ rooms: DEFAULT_ROOMS, doctorDirectory: {}, chime: DEFAULT_STATE.chime, schedule: DEFAULT_SCHEDULE });
  const [roomsData, setRoomsData] = useState({}); // roomId → { assigned, sessions, ... }
  const [ready, setReady] = useState(false);
  const configRef = useRef(config);
  const roomsRef = useRef(roomsData);
  configRef.current = config;
  roomsRef.current = roomsData;

  // Subscribe to config doc
  useEffect(() => {
    const unsub = onSnapshot(CONFIG_DOC, (snap) => {
      const data = snap.exists() ? snap.data() : {};
      setConfig({
        rooms: data.rooms || DEFAULT_ROOMS,
        doctorDirectory: data.doctorDirectory || {},
        chime: { ...DEFAULT_STATE.chime, ...(data.chime || {}) },
        schedule: { ...DEFAULT_SCHEDULE, ...(data.schedule || {}) },
      });
      setReady(true);
    });
    return unsub;
  }, []);

  // Subscribe to all room docs
  useEffect(() => {
    const unsub = onSnapshot(ROOMS_COL, (snap) => {
      const next = {};
      snap.forEach((d) => { next[d.id] = d.data(); });
      setRoomsData(next);
    });
    return unsub;
  }, []);

  // Merge config + rooms into the flat shape portals use
  const state = (() => {
    const rooms = config.rooms || DEFAULT_ROOMS;
    const merged = {
      rooms,
      doctorDirectory: config.doctorDirectory || {},
      chime: config.chime,
      schedule: config.schedule,
      assigned: {}, sessions: {}, nowServing: {}, upNext: {}, customCall: {}, status: {},
    };
    rooms.forEach((id) => {
      const r = roomsData[id] || {};
      merged.assigned[id]   = r.assigned ?? null;
      merged.sessions[id]   = r.sessions ?? null;
      merged.nowServing[id] = r.nowServing ?? null;
      merged.upNext[id]     = r.upNext ?? null;
      merged.customCall[id] = r.customCall ?? null;
      merged.status[id]     = r.status ?? "IDLE";
    });
    return merged;
  })();

  // setState — accepts a full next-state object (back-compat with existing portals).
  // Routes config fields to the config doc and any changed room fields to room docs.
  const setState = useCallback(async (next, audit) => {
    const cur = { config: configRef.current, rooms: roomsRef.current };

    // Detect config changes
    const configChanged = CONFIG_FIELDS.some((f) =>
      JSON.stringify(next[f]) !== JSON.stringify(cur.config[f])
    );
    if (configChanged) {
      await pushConfig({ rooms: next.rooms, doctorDirectory: next.doctorDirectory, chime: next.chime, schedule: next.schedule });
    }

    // Detect per-room changes and write only those rooms
    const roomIds = next.rooms || DEFAULT_ROOMS;
    const writes = [];
    roomIds.forEach((id) => {
      const before = cur.rooms[id] || {};
      const after = {
        assigned: next.assigned?.[id] ?? null,
        sessions: next.sessions?.[id] ?? null,
        nowServing: next.nowServing?.[id] ?? null,
        upNext: next.upNext?.[id] ?? null,
        customCall: next.customCall?.[id] ?? null,
        status: next.status?.[id] ?? "IDLE",
      };
      const changed = ROOM_FIELDS.some((f) =>
        JSON.stringify(before[f] ?? (f === "status" ? "IDLE" : null)) !== JSON.stringify(after[f])
      );
      if (changed) writes.push(pushRoom(id, after));
    });
    await Promise.all(writes);

    if (audit) logAudit(audit);
  }, []);

  // setRoom — targeted single-room write. Pass the merged state, roomId, and a patch.
  const setRoom = useCallback(async (roomId, patch, audit) => {
    const before = roomsRef.current[roomId] || {};
    const after = {
      assigned:   patch.assigned   !== undefined ? patch.assigned   : (before.assigned ?? null),
      sessions:   patch.sessions   !== undefined ? patch.sessions   : (before.sessions ?? null),
      nowServing: patch.nowServing !== undefined ? patch.nowServing : (before.nowServing ?? null),
      upNext:     patch.upNext     !== undefined ? patch.upNext     : (before.upNext ?? null),
      customCall: patch.customCall !== undefined ? patch.customCall : (before.customCall ?? null),
      status:     patch.status     !== undefined ? patch.status     : (before.status ?? "IDLE"),
    };
    await pushRoom(roomId, after);
    if (audit) logAudit(audit);
  }, []);

  return { state, setState, setRoom, ready };
}

/* ─────────────────────────────────────────────
   AUTH — Firebase Auth state hook
───────────────────────────────────────────── */
function useAuth() {
  const [authState, setAuthState] = useState({ user: null, role: null, room: null, loading: true });
  useEffect(() => {
    const unsub = onAuthChange((s) => setAuthState({ ...s, loading: false }));
    return unsub;
  }, []);
  return authState;
}

/* ─────────────────────────────────────────────
   STATUS COLOR HELPER
───────────────────────────────────────────── */
function statusColor(s) {
  switch (s) {
    case "SESSION STARTED": return "#22c55e";
    case "CALLING": return "#3b82f6";
    case "RECALL": return "#f59e0b";
    case "PAUSED": return "#6b7280";
    case "SESSION ENDED": return "#ef4444";
    default: return "#64748b";
  }
}

/* ═══════════════════════════════════════════
   APP ROOT
═══════════════════════════════════════════ */
export default function ClinicQ() {
  const { role, room, loading } = useAuth();
  const [page, setPage] = useState(() => window.location.hash.replace("#", "") || "lobby");

  useEffect(() => {
    const onHash = () => setPage(window.location.hash.replace("#", "") || "lobby");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Complete Google redirect sign-in if returning from redirect flow
  useEffect(() => {
    completeGoogleRedirect().then((r) => {
      if (r?.success) { /* auth state listener will handle nav */ }
    }).catch(() => {});
  }, []);

  // Redirect to login if trying to access protected page while not authenticated
  useEffect(() => {
    if (loading) return;
    const protected_ = ["doctor", "admin", "superadmin", "developer"];
    if (protected_.includes(page) && !role) { navigate("login"); }
    if (page === "doctor"     && role && role !== "DOCTOR")     { navigate("login"); }
    if (page === "admin"      && role && role !== "ADMIN")      { navigate("login"); }
    if (page === "superadmin" && role && role !== "SUPERADMIN") { navigate("login"); }
    if (page === "developer"  && role && role !== "DEVELOPER")  { navigate("login"); }
  }, [page, role, loading]);

  // After login, redirect to the right portal
  useEffect(() => {
    if (loading || !role) return;
    if (page === "login") {
      navigate(role === "DEVELOPER" ? "developer" : role === "SUPERADMIN" ? "superadmin" : role === "ADMIN" ? "admin" : "doctor");
    }
  }, [role, loading]);

  // First-run seeding — only the authenticated Developer can write credentials
  // under the locked Firestore rules. Runs once when a Developer signs in.
  useEffect(() => {
    if (loading || role !== "DEVELOPER") return;
    initCredentials(DEFAULT_ROOMS).catch((e) => console.warn("Seeding:", e.message));
  }, [role, loading]);

  const navigate = (p) => {
    if (p === "lobby") {
      history.replaceState(null, "", window.location.pathname);
      setPage("lobby");
    } else {
      window.location.hash = p;
      setPage(p);
    }
  };

  if (loading) return (
    <>
      <style>{GLOBAL_CSS}</style>
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#080b12" }}>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", color: "#fff", opacity: 0.5 }}>
          <div className="spinner" />
          <span style={{ fontFamily: "sans-serif" }}>Connecting…</span>
        </div>
      </div>
    </>
  );

  const showNav = page !== "lobby";

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      {showNav && <TopNav navigate={navigate} role={role} room={room} />}
      <div className={showNav ? "page-wrap" : ""}>
        {page === "lobby"      && <Lobby />}
        {page === "login"      && <LoginPage navigate={navigate} />}
        {page === "doctor"     && role === "DOCTOR"     && <DoctorPortal room={room} />}
        {page === "admin"      && role === "ADMIN"      && <AdminPortal />}
        {page === "superadmin" && role === "SUPERADMIN" && <SuperAdminPortal />}
        {page === "developer"  && role === "DEVELOPER"  && <DeveloperPortal />}
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────
   TOP NAV
───────────────────────────────────────────── */
function TopNav({ navigate, role, room }) {
  const logout = async () => { await logout_(); navigate("lobby"); };

  return (
    <nav className="topnav">
      <span className="topnav-brand" onClick={() => navigate("lobby")}>
        <span className="topnav-dot" />
        ClinicQ <span className="topnav-ver">v{APP_VERSION}</span>
      </span>
      <div className="topnav-links">
        {role === "DOCTOR" && <a onClick={() => navigate("doctor")}>Doctor {room ? `· ${room}` : ""}</a>}
        {role === "ADMIN" && <a onClick={() => navigate("admin")}>Admin</a>}
        {role === "SUPERADMIN" && <a onClick={() => navigate("superadmin")}>Super-Admin</a>}
        {role === "DEVELOPER" && <a onClick={() => navigate("developer")}>Developer</a>}
        {!role && <a onClick={() => navigate("login")}>Sign in</a>}
        {role && <a className="logout" onClick={logout}>Logout</a>}
      </div>
    </nav>
  );
}

/* ─────────────────────────────────────────────
   LOBBY LOGO
───────────────────────────────────────────── */
function LobbyLogo() {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    getDownloadURL(ref(storage, LOGO_PATH))
      .then(setUrl)
      .catch(() => setUrl(null));
  }, []);
  return (
    <div className="lobby-logo-wrap">
      {url
        ? <img src={url} alt={CLINIC_NAME} className="lobby-logo-img" />
        : <div className="lobby-logo-text">{CLINIC_NAME}</div>
      }
    </div>
  );
}

/* ─────────────────────────────────────────────
   LOBBY QR CODE
───────────────────────────────────────────── */
function LobbyQR({ url }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = 80;
    // Simple QR using qrcode library via CDN — fallback to text if unavailable
    import("https://esm.sh/qrcode@1.5.3").then((QRCode) => {
      QRCode.toCanvas(canvas, url, {
        width: size, margin: 1,
        color: { dark: "#ffffff", light: "#00000000" },
      });
    }).catch(() => {});
  }, [url]);
  return (
    <div className="lobby-qr-wrap">
      <canvas ref={canvasRef} width={80} height={80} />
      <div className="lobby-qr-label">Scan to view queue</div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   LOBBY ROOM CARD — extracted for clean animation
───────────────────────────────────────────── */
function LobbyCard({ id, state }) {
  const doc = state.assigned[id];
  const s = state.status[id];
  const token = state.customCall[id] ?? state.nowServing[id];
  const next = state.upNext[id];
  const [flash, setFlash] = useState(false);
  const prevToken = useRef(token);

  useEffect(() => {
    if (prevToken.current !== token) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1200);
      prevToken.current = token;
      return () => clearTimeout(t);
    }
  }, [token]);

  return (
    <div className={`lobby-card${flash ? " lobby-card-flash" : ""}`} style={{ "--accent": statusColor(s) }}>
      <div className="lobby-card-top">
        <div className="lobby-room-id">{id}</div>
        <div className="lobby-status-badge" style={{ background: statusColor(s) + "22", color: statusColor(s), border: `1px solid ${statusColor(s)}44` }}>{s}</div>
      </div>
      <div className="lobby-doctor">{doc?.name}</div>
      <div className="lobby-dept">{doc?.department || "General"}</div>
      <div className="lobby-token-row">
        <div className="lobby-token-block">
          <div className="lobby-token-label">NOW SERVING</div>
          <div className={`lobby-token-num${flash ? " lobby-token-animate" : ""}`}>{token ?? "—"}</div>
        </div>
        <div className="lobby-divider" />
        <div className="lobby-token-block">
          <div className="lobby-token-label">UP NEXT</div>
          <div className="lobby-token-num lobby-token-next">{next ?? "—"}</div>
        </div>
        <div className="lobby-divider" />
        <div className="lobby-token-block">
          <div className="lobby-token-label">WAITING</div>
          <div className="lobby-token-num lobby-token-waiting">{(state.queues?.[id] || []).length}</div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   LOBBY (TV display)
───────────────────────────────────────────── */
/* ─────────────────────────────────────────────
   SCHEDULE HELPERS
───────────────────────────────────────────── */
function hhmmToMin(s) {
  const [h, m] = (s || "0:0").split(":").map(Number);
  return h * 60 + (m || 0);
}

// Is the clinic open right now per the schedule?
function isClinicOpen(schedule) {
  if (!schedule?.enabled) return true; // feature off → always show live queue
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const open = hhmmToMin(schedule.openTime || "08:00");
  const close = hhmmToMin(schedule.closeTime || "17:00");
  if (open === close) return true;
  if (open < close) return cur >= open && cur < close;
  return cur >= open || cur < close; // overnight span
}

/* ─────────────────────────────────────────────
   CLOSED SPLASH — full custom PNG with clock + QR
───────────────────────────────────────────── */
function ClosedSplash({ schedule }) {
  const [splashUrl, setSplashUrl] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    getDownloadURL(ref(storage, SPLASH_PATH)).then(setSplashUrl).catch(() => setSplashUrl(null));
  }, []);

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div className="splash">
      {splashUrl
        ? <img src={splashUrl} alt="Clinic closed" className="splash-img" />
        : (
          <div className="splash-fallback">
            <div className="splash-logo">{CLINIC_NAME}</div>
            <div className="splash-closed">Closed</div>
            <div className="splash-hours">Opens at {schedule?.openTime || "08:00"}</div>
          </div>
        )
      }
      <div className="splash-overlay">
        <div className="splash-clock">{timeStr}</div>
        <LobbyQR url={APP_URL} />
      </div>
    </div>
  );
}

function Lobby() {
  const { state, setRoom, ready } = useClinicState();
  const [tick, setTick] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const lobbyRef = useRef(null);
  const lastClearRef = useRef(null);

  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      lobbyRef.current?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  // Daily auto-clear: once per day at the configured clearTime, wipe yesterday's
  // tokens/status on all rooms (keeps doctor assignments).
  useEffect(() => {
    if (!ready || !state.schedule?.enabled) return;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const clearAt = hhmmToMin(state.schedule.clearTime || "06:00");
    const todayKey = now.toISOString().slice(0, 10);
    const storedKey = localStorage.getItem("cq_last_clear");

    // Within a 2-minute window of clearTime, and not already cleared today
    if (cur >= clearAt && cur < clearAt + 2 && storedKey !== todayKey && lastClearRef.current !== todayKey) {
      lastClearRef.current = todayKey;
      localStorage.setItem("cq_last_clear", todayKey);
      (state.rooms || DEFAULT_ROOMS).forEach((id) => {
        if (state.status[id] !== "IDLE" || state.nowServing[id] != null) {
          setRoom(id, {
            sessions: null, nowServing: null, upNext: null,
            customCall: null, status: "IDLE",
          }, { role: "SYSTEM", action: "dailyAutoClear", room: id });
        }
      });
    }
  }, [tick, ready]);

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  // Outside opening hours → show the closed splash
  if (ready && !isClinicOpen(state.schedule)) {
    return (
      <div className="lobby" ref={lobbyRef} style={{ padding: 0 }}>
        <ClosedSplash schedule={state.schedule} />
      </div>
    );
  }

  const rooms = (state.rooms || DEFAULT_ROOMS).filter((id) => state.assigned[id]);

  return (
    <div className="lobby" ref={lobbyRef}>
      <div className="lobby-header">
        <div className="lobby-brand">
          <LobbyLogo />
        </div>
        <div className="lobby-center">
          <div className="lobby-clock">
            <div className="lobby-time">{timeStr}</div>
            <div className="lobby-date">{dateStr}</div>
          </div>
        </div>
        <div className="lobby-right">
          <LobbyQR url={APP_URL} />
          <button className="lobby-fs-btn" onClick={toggleFullscreen} title={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
            {fullscreen ? "⛶" : "⛶"}
            <span style={{ fontSize: "0.7rem", display: "block", opacity: 0.6 }}>{fullscreen ? "exit" : "fullscreen"}</span>
          </button>
        </div>
      </div>

      {!ready && (
        <div className="lobby-loading">
          <div className="spinner" />
          <span>Connecting…</span>
        </div>
      )}

      {ready && rooms.length === 0 && (
        <div className="lobby-empty">No active rooms at this time.</div>
      )}

      {ready && rooms.length > 0 && (
        <div className={`lobby-grid lobby-grid-${Math.min(rooms.length, 4)}`}>
          {rooms.map((id) => <LobbyCard key={id} id={id} state={state} />)}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   LOGIN — credentials verified against Firestore
───────────────────────────────────────────── */
function LoginPage({ navigate }) {
  const { state } = useClinicState();
  const [role, setRole] = useState("DOCTOR");
  const [room, setRoom] = useState((state.rooms || DEFAULT_ROOMS)[0]);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // Note: first-run seeding happens after Developer Google sign-in (see App root),
  // since locked Firestore rules require authentication to write credentials.

  const submit = async () => {
    if (loading) return;
    setErr("");
    setLoading(true);
    try {
      const result = await verifyLogin(role, user, pass, role === "DOCTOR" ? room : null);
      if (result.success) {
        // Firebase Auth state change will trigger redirect via useEffect in App root
      } else {
        setErr(result.error);
      }
    } catch (e) {
      setErr(e.message || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="portal-bg">
      <div className="login-card">
        <div className="login-logo"><span className="lobby-pulse" style={{ width: 10, height: 10 }} />ClinicQ</div>
        <h2 className="login-title">Sign in</h2>

        <div className="field-group">
          <label className="field-label">Role</label>
          <select className="field-input" value={role} onChange={(e) => { setRole(e.target.value); setErr(""); }}>
            <option value="DOCTOR">Doctor</option>
            <option value="ADMIN">Admin</option>
            <option value="SUPERADMIN">Super-Admin</option>
          </select>
        </div>

        {role === "DOCTOR" && (
          <div className="field-group">
            <label className="field-label">Room</label>
            <select className="field-input" value={room} onChange={(e) => setRoom(e.target.value)}>
              {(state.rooms || DEFAULT_ROOMS).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        )}

        <div className="field-group">
          <label className="field-label">Username</label>
          <input className="field-input" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" />
        </div>

        <div className="field-group">
          <label className="field-label">Password</label>
          <input className="field-input" type="password" value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            autoComplete="current-password" />
        </div>

        {err && <div className="login-err">{err}</div>}
        <button className="btn btn-primary w-full" onClick={submit} disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>

        <div className="login-divider"><span>or</span></div>

        <button className="btn btn-google w-full" onClick={async () => {
          setErr(""); setLoading(true);
          try {
            const r = await signInWithGoogle();
            if (!r.success) setErr(r.error);
          } catch (e) { setErr(e.message); }
          finally { setLoading(false); }
        }} disabled={loading}>
          <svg width="18" height="18" viewBox="0 0 18 18" style={{marginRight:"8px"}}><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/></svg>
          Sign in with Google
        </button>
        <div className="dim" style={{fontSize:"0.75rem",textAlign:"center",marginTop:"0.5rem"}}>Developer access only</div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   DOCTOR PORTAL
───────────────────────────────────────────── */
function DoctorPortal({ room = "R01" }) {
  const { state, setRoom, ready } = useClinicState();
  // room passed from App root via Firebase Auth state
  const play = useChime(state.chime);

  const assigned = state.assigned[room];
  const nowServing = state.customCall[room] ?? state.nowServing[room];
  const upNext = state.upNext[room];
  const status = state.status[room] || "IDLE";
  const session = state.sessions[room];

  // Write only this room's document, then chime
  const act = async (patch, auditAction, chimeType = "CALL") => {
    await setRoom(room, patch, { role: "DOCTOR", action: auditAction, room, ts: Date.now() });
    play(chimeType, { force: true });
  };

  const startSession = () => {
    const tokenStart = 1;
    act({
      sessions: { startedAt: Date.now(), tokenStart, served: 0 },
      nowServing: tokenStart,
      upNext: tokenStart + 1,
      customCall: null,
      status: "SESSION STARTED",
    }, "startSession", "CALL");
  };

  const endSession = async () => {
    const sess = state.sessions[room];
    const endedAt = Date.now();
    // Save completed session to history
    if (sess?.startedAt) {
      try {
        await addDoc(SESSIONS_COL, {
          room,
          doctor: assigned?.name || "Unknown",
          doctorId: assigned?.id || null,
          department: assigned?.department || "General",
          startedAt: Timestamp.fromMillis(sess.startedAt),
          endedAt: Timestamp.fromMillis(endedAt),
          durationMin: Math.round((endedAt - sess.startedAt) / 60000),
          tokensServed: sess.served || 0,
          startHour: new Date(sess.startedAt).getHours(),
          date: new Date(sess.startedAt).toISOString().slice(0, 10),
        });
      } catch (e) { console.warn("Session save failed:", e.message); }
    }
    act({
      sessions: null,
      nowServing: null,
      upNext: null,
      customCall: null,
      status: "SESSION ENDED",
    }, "endSession", "END");
  };

  const nextToken = () => {
    const cur = state.nowServing[room] || 0;
    const next = cur + 1;
    const sess = state.sessions[room];
    act({
      nowServing: next,
      upNext: next + 1,
      customCall: null,
      status: "CALLING",
      sessions: sess ? { ...sess, served: (sess.served || 0) + 1 } : null,
    }, "next", "CALL");
  };

  const prevToken = () => {
    const cur = Math.max(1, (state.nowServing[room] || 1) - 1);
    act({
      nowServing: cur,
      upNext: cur + 1,
      customCall: null,
      status: "CALLING",
    }, "previous", "CALL");
  };

  const pauseResume = () => {
    const next = status === "PAUSED" ? "CALLING" : "PAUSED";
    act({ status: next }, next === "PAUSED" ? "pause" : "resume", "CALL");
  };

  const recall = () => {
    act({ status: "RECALL" }, "recall", "RECALL");
  };

  const customCall = () => {
    const value = prompt("Enter custom token to call:");
    if (!value) return;
    act({ customCall: value, status: "CALLING" }, "customCall", "CALL");
  };

  const manualToken = () => {
    const val = prompt("Set Now Serving to:");
    const n = parseInt(val, 10);
    if (isNaN(n) || n < 1) return;
    act({
      nowServing: n,
      upNext: n + 1,
      customCall: null,
      status: "CALLING",
    }, "manualToken", "CALL");
  };

  const sessionDur = session?.startedAt
    ? Math.round((Date.now() - session.startedAt) / 60000)
    : 0;

  return (
    <div className="portal-bg">
      <div className="portal-container">
        <div className="portal-header">
          <div>
            <h1 className="portal-title">Doctor Portal</h1>
            <div className="portal-sub">{room}{assigned ? ` · ${assigned.name}` : " · Unassigned"}</div>
          </div>
          <div className="status-pill" style={{ background: statusColor(status) + "22", color: statusColor(status) }}>
            {status}
          </div>
        </div>

        {/* Token Display */}
        <div className="doctor-token-display">
          <div className="doctor-token-block">
            <div className="doctor-token-label">NOW SERVING</div>
            <div className="doctor-token-big">{nowServing ?? "—"}</div>
          </div>
          <div className="doctor-token-sep" />
          <div className="doctor-token-block">
            <div className="doctor-token-label">UP NEXT</div>
            <div className="doctor-token-big" style={{ fontSize: "2.2rem", opacity: 0.6 }}>{upNext ?? "—"}</div>
          </div>
          {session && (
            <div className="doctor-token-block">
              <div className="doctor-token-label">SESSION</div>
              <div className="doctor-token-big" style={{ fontSize: "1.4rem", opacity: 0.7 }}>{sessionDur}m · {session.served || 0} served</div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="doctor-actions">
          <div className="action-section-title">Session</div>
          <div className="action-row">
            <button className="btn btn-green" onClick={startSession}>▶ Start Session</button>
            <button className="btn btn-red" onClick={endSession}>■ End Session</button>
          </div>

          <div className="action-section-title">Token Control</div>
          <div className="action-row">
            <button className="btn btn-blue" onClick={nextToken}>⏭ Next</button>
            <button className="btn btn-outline" onClick={prevToken}>⏮ Previous</button>
            <button className="btn btn-outline" onClick={recall}>↩ Recall</button>
          </div>

          <div className="action-section-title">Advanced</div>
          <div className="action-row">
            <button className="btn btn-outline" onClick={pauseResume}>
              {status === "PAUSED" ? "▶ Resume" : "⏸ Pause"}
            </button>
            <button className="btn btn-outline" onClick={customCall}>✎ Custom Call</button>
            <button className="btn btn-outline" onClick={manualToken}>⌨ Set Token</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   ADMIN PORTAL
───────────────────────────────────────────── */
function AdminPortal() {
  const { state, setRoom, ready } = useClinicState();
  const [tab, setTab] = useState("rooms");
  const [auditLog, setAuditLog] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const activeDoctors = Object.values(state.doctorDirectory || {}).filter((d) => d.active);

  const assign = async (roomId, doctorId) => {
    const doc = doctorId ? state.doctorDirectory[doctorId] : null;
    await setRoom(roomId, {
      assigned: doc ? { id: doc.id, name: doc.name, department: doc.specialty || "General" } : null,
      // Reset room to a clean slate for the newly assigned doctor
      status: "IDLE",
      sessions: null,
      nowServing: null,
      upNext: null,
      customCall: null,
    }, { role: "ADMIN", action: "assignDoctor", roomId, doctorId });
  };

  const endSession = async (roomId) => {
    if (!window.confirm(`End session for ${roomId}?`)) return;
    await setRoom(roomId, {
      assigned: null,
      sessions: null,
      nowServing: null,
      upNext: null,
      customCall: null,
      status: "SESSION ENDED",
    }, { role: "ADMIN", action: "endSession", roomId });
  };

  const loadAudit = async () => {
    setAuditLoading(true);
    try {
      const q = query(AUDIT_COL, orderBy("ts", "desc"), limit(50));
      const snap = await getDocs(q);
      setAuditLog(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      setAuditLog([{ id: "err", action: "Failed to load: " + e.message }]);
    }
    setAuditLoading(false);
  };

  useEffect(() => { if (tab === "audit") loadAudit(); }, [tab]);

  const sessionStats = (state.rooms || DEFAULT_ROOMS).map((id) => {
    const sess = state.sessions[id];
    return {
      id,
      doctor: state.assigned[id]?.name || "—",
      status: state.status[id],
      served: sess?.served || 0,
      durationMin: sess?.startedAt ? Math.round((Date.now() - sess.startedAt) / 60000) : 0,
      startedAt: sess?.startedAt,
    };
  });

  return (
    <div className="portal-bg">
      <div className="portal-container">
        <div className="portal-header">
          <div>
            <h1 className="portal-title">Admin Portal</h1>
            <div className="portal-sub">Room management &amp; oversight</div>
          </div>
        </div>

        <div className="tab-bar">
          {["rooms", "analytics", "audit"].map((t) => (
            <button key={t} className={`tab-btn${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {t === "rooms" ? "🏥 Rooms" : t === "analytics" ? "📊 Analytics" : "📋 Audit Log"}
            </button>
          ))}
        </div>

        {tab === "rooms" && (
          <div className="card">
            <h2 className="card-title">Assign Doctors to Rooms</h2>
            <div className="room-assign-grid">
              {(state.rooms || DEFAULT_ROOMS).map((r) => (
                <div key={r} className="room-assign-row">
                  <div className="room-assign-id">{r}</div>
                  <select
                    className="field-input"
                    value={state.assigned[r]?.id || ""}
                    onChange={(e) => assign(r, e.target.value || null)}
                  >
                    <option value="">— Unassigned —</option>
                    {activeDoctors.map((d) => (
                      <option key={d.id} value={d.id}>{d.name} ({d.specialty || "General"})</option>
                    ))}
                  </select>
                  <button className="btn btn-red btn-sm" onClick={() => endSession(r)}>End</button>
                </div>
              ))}
            </div>

            <h2 className="card-title" style={{ marginTop: "1.5rem" }}>Room Status</h2>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Room</th><th>Doctor</th><th>Status</th><th>Now</th><th>Next</th></tr></thead>
                <tbody>
                  {(state.rooms || DEFAULT_ROOMS).map((r) => (
                    <tr key={r}>
                      <td className="mono">{r}</td>
                      <td>{state.assigned[r]?.name || <span className="dim">—</span>}</td>
                      <td><span className="status-pill" style={{ background: statusColor(state.status[r]) + "22", color: statusColor(state.status[r]) }}>{state.status[r]}</span></td>
                      <td className="mono">{state.nowServing[r] ?? "—"}</td>
                      <td className="mono">{state.upNext[r] ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "audit" && (
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h2 className="card-title" style={{ margin: 0 }}>Audit Log (last 50)</h2>
              <button className="btn btn-outline btn-sm" onClick={loadAudit}>↻ Refresh</button>
            </div>
            {auditLoading && <div className="dim">Loading…</div>}
            {!auditLoading && auditLog.length === 0 && <div className="dim">No entries yet.</div>}
            {!auditLoading && auditLog.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Time</th><th>Role</th><th>Action</th><th>Room</th></tr></thead>
                  <tbody>
                    {auditLog.map((e) => (
                      <tr key={e.id}>
                        <td className="dim mono" style={{ fontSize: "0.75rem" }}>
                          {e.ts?.toDate ? e.ts.toDate().toLocaleTimeString() : "—"}
                        </td>
                        <td>{e.role || "—"}</td>
                        <td>{e.action || "—"}</td>
                        <td className="mono">{e.room || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "analytics" && <AnalyticsTab />}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   SUPER-ADMIN PORTAL
───────────────────────────────────────────── */
function SuperAdminPortal() {
  const { state, setState, ready } = useClinicState();
  const [tab, setTab] = useState("doctors");
  const [form, setForm] = useState({ name: "", specialty: "" });
  const [newRoom, setNewRoom] = useState("");

  const saveState = async (next, audit) => {
    await setState(next, audit);
  };

  /* Doctor CRUD */
  const addDoctor = async () => {
    const name = form.name.trim();
    if (!name) return;
    const id = `doc_${Date.now()}`;
    const next = {
      ...state,
      doctorDirectory: { ...state.doctorDirectory, [id]: { id, name, specialty: form.specialty.trim(), active: true } },
    };
    await saveState(next, { role: "SUPERADMIN", action: "doctorAdd", id });
    setForm({ name: "", specialty: "" });
  };

  const editDoctor = async (id) => {
    const d = state.doctorDirectory[id];
    const name = prompt("Name:", d.name);
    if (!name) return;
    const specialty = prompt("Specialty:", d.specialty || "");
    const next = {
      ...state,
      doctorDirectory: { ...state.doctorDirectory, [id]: { ...d, name: name.trim(), specialty: (specialty || "").trim() } },
    };
    await saveState(next, { role: "SUPERADMIN", action: "doctorEdit", id });
  };

  const toggleDoctor = async (id, active) => {
    const next = {
      ...state,
      doctorDirectory: { ...state.doctorDirectory, [id]: { ...state.doctorDirectory[id], active } },
    };
    await saveState(next, { role: "SUPERADMIN", action: active ? "doctorReactivate" : "doctorDeactivate", id });
  };

  const deleteDoctor = async (id) => {
    if (Object.values(state.assigned || {}).some((a) => a?.id === id)) {
      alert("Cannot delete: doctor is assigned to a room."); return;
    }
    if (!window.confirm("Delete this doctor?")) return;
    const next = { ...state, doctorDirectory: { ...state.doctorDirectory } };
    delete next.doctorDirectory[id];
    await saveState(next, { role: "SUPERADMIN", action: "doctorDelete", id });
  };

  /* Room management */
  const addRoom = async () => {
    const id = newRoom.trim().toUpperCase();
    if (!id || (state.rooms || []).includes(id)) return;
    const rooms = [...(state.rooms || DEFAULT_ROOMS), id];
    const next = {
      ...state,
      rooms,
      assigned: { ...state.assigned, [id]: null },
      sessions: { ...state.sessions, [id]: null },
      nowServing: { ...state.nowServing, [id]: null },
      upNext: { ...state.upNext, [id]: null },
      customCall: { ...state.customCall, [id]: null },
      status: { ...state.status, [id]: "IDLE" },
    };
    await saveState(next, { role: "SUPERADMIN", action: "addRoom", id });
    await addRoomCredential(id); // seed default credential in auth doc
    setNewRoom("");
  };

  const removeRoom = async (id) => {
    if (!window.confirm(`Remove room ${id}? This cannot be undone.`)) return;
    const rooms = (state.rooms || []).filter((r) => r !== id);
    await saveState({ ...state, rooms }, { role: "SUPERADMIN", action: "removeRoom", id });
    await deleteRoomDoc(id);
    await removeRoomCredential(id);
  };

  /* Chime */
  const updateChime = async (patch) => {
    const next = { ...state, chime: { ...state.chime, ...patch } };
    await saveState(next, { role: "SUPERADMIN", action: "chimeUpdate" });
  };

  const testChime = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const vol = ctx.createGain(); vol.gain.value = state.chime?.volume ?? 0.22; vol.connect(ctx.destination);
      const beep = (t, f) => { const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; o.connect(vol); o.start(t); o.stop(t + 0.14); };
      const t0 = ctx.currentTime + 0.01; beep(t0, 880); beep(t0 + 0.22, 1046);
    } catch {}
  };

  const doctors = Object.values(state.doctorDirectory || {});

  return (
    <div className="portal-bg">
      <div className="portal-container">
        <div className="portal-header">
          <div>
            <h1 className="portal-title">Super-Admin</h1>
            <div className="portal-sub">System configuration</div>
          </div>
        </div>

        <div className="tab-bar">
          {["doctors", "rooms", "credentials", "chime", "branding", "schedule"].map((t) => (
            <button key={t} className={`tab-btn${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {t === "doctors" ? "👤 Doctors" : t === "rooms" ? "🏥 Rooms" : t === "credentials" ? "🔑 Credentials" : t === "chime" ? "🔔 Chime" : t === "branding" ? "🎨 Branding" : "🕐 Schedule"}
            </button>
          ))}
        </div>

        {tab === "doctors" && (
          <div className="card">
            <h2 className="card-title">Doctor Directory</h2>
            <div className="add-row">
              <input className="field-input" placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input className="field-input" placeholder="Specialty (optional)" value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} />
              <button className="btn btn-green" onClick={addDoctor}>+ Add</button>
            </div>
            {doctors.length === 0 && <div className="dim">No doctors added yet.</div>}
            <div className="divide-list">
              {doctors.map((d) => (
                <div key={d.id} className="divide-row">
                  <div>
                    <div className="fw-med">{d.name}</div>
                    <div className="dim" style={{ fontSize: "0.82rem" }}>{d.specialty || "General"} · <span style={{ color: d.active ? "#22c55e" : "#ef4444" }}>{d.active ? "Active" : "Inactive"}</span></div>
                  </div>
                  <div className="btn-group">
                    <button className="btn btn-outline btn-sm" onClick={() => editDoctor(d.id)}>Edit</button>
                    <button className={`btn btn-sm ${d.active ? "btn-yellow" : "btn-green"}`} onClick={() => toggleDoctor(d.id, !d.active)}>
                      {d.active ? "Deactivate" : "Reactivate"}
                    </button>
                    <button className="btn btn-red btn-sm" onClick={() => deleteDoctor(d.id)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "rooms" && (
          <div className="card">
            <h2 className="card-title">Room Management</h2>
            <div className="add-row">
              <input className="field-input" placeholder="Room ID (e.g. R06)" value={newRoom} onChange={(e) => setNewRoom(e.target.value)} />
              <button className="btn btn-green" onClick={addRoom}>+ Add Room</button>
            </div>
            <div className="divide-list">
              {(state.rooms || DEFAULT_ROOMS).map((r) => (
                <div key={r} className="divide-row">
                  <div>
                    <div className="fw-med mono">{r}</div>
                    <div className="dim" style={{ fontSize: "0.82rem" }}>{state.assigned[r]?.name || "Unassigned"} · {state.status[r]}</div>
                  </div>
                  <button className="btn btn-red btn-sm" onClick={() => removeRoom(r)}>Remove</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "credentials" && (
          <CredentialsTab rooms={state.rooms || DEFAULT_ROOMS} />
        )}

        {tab === "chime" && (
          <div className="card">
            <h2 className="card-title">Chime Settings</h2>
            <div className="chime-grid">
              <label className="toggle-row">
                <span>Enabled</span>
                <input type="checkbox" checked={!!state.chime?.enabled} onChange={(e) => updateChime({ enabled: e.target.checked })} />
              </label>
              <label className="toggle-row">
                <span>Do Not Disturb</span>
                <input type="checkbox" checked={!!state.chime?.doNotDisturb} onChange={(e) => updateChime({ doNotDisturb: e.target.checked })} />
              </label>
              <div className="field-group">
                <label className="field-label">Volume — {Math.round((state.chime?.volume ?? 0.22) * 100)}%</label>
                <input type="range" min="0" max="1" step="0.01" value={state.chime?.volume ?? 0.22} onChange={(e) => updateChime({ volume: parseFloat(e.target.value) })} style={{ width: "100%" }} />
              </div>
              <div className="field-group">
                <label className="field-label">Quiet Hours</label>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input type="time" className="field-input" style={{ width: "auto" }} value={state.chime?.dndStart || "22:00"} onChange={(e) => updateChime({ dndStart: e.target.value })} />
                  <span className="dim">to</span>
                  <input type="time" className="field-input" style={{ width: "auto" }} value={state.chime?.dndEnd || "07:00"} onChange={(e) => updateChime({ dndEnd: e.target.value })} />
                </div>
              </div>
              <div className="field-group">
                <label className="field-label">Min gap between chimes (sec)</label>
                <input type="number" className="field-input" style={{ width: "80px" }} min="0" max="30" value={state.chime?.minGapSec ?? 3} onChange={(e) => updateChime({ minGapSec: parseInt(e.target.value) || 0 })} />
              </div>
              <button className="btn btn-blue" onClick={testChime}>🔔 Test Chime</button>
            </div>
          </div>
        )}

        {tab === "branding" && <BrandingTab />}
        {tab === "schedule" && <ScheduleTab state={state} setState={setState} />}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   DEVELOPER PORTAL
───────────────────────────────────────────── */
function DeveloperPortal() {
  const { state, setState } = useClinicState();
  const [tab, setTab] = useState("doctors");
  const [form, setForm] = useState({ name: "", specialty: "" });
  const [newRoom, setNewRoom] = useState("");

  /* Doctor CRUD */
  const addDoctor = async () => {
    const name = form.name.trim();
    if (!name) return;
    const id = `doc_${Date.now()}`;
    const next = { ...state, doctorDirectory: { ...state.doctorDirectory, [id]: { id, name, specialty: form.specialty.trim(), active: true } } };
    await setState(next, { role: "DEVELOPER", action: "doctorAdd", id });
    setForm({ name: "", specialty: "" });
  };
  const editDoctor = async (id) => {
    const d = state.doctorDirectory[id];
    const name = prompt("Name:", d.name); if (!name) return;
    const specialty = prompt("Specialty:", d.specialty || "") ?? "";
    const next = { ...state, doctorDirectory: { ...state.doctorDirectory, [id]: { ...d, name: name.trim(), specialty: specialty.trim() } } };
    await setState(next, { role: "DEVELOPER", action: "doctorEdit", id });
  };
  const toggleDoctor = async (id, active) => {
    const next = { ...state, doctorDirectory: { ...state.doctorDirectory, [id]: { ...state.doctorDirectory[id], active } } };
    await setState(next, { role: "DEVELOPER", action: active ? "doctorReactivate" : "doctorDeactivate", id });
  };
  const deleteDoctor = async (id) => {
    if (Object.values(state.assigned || {}).some((a) => a?.id === id)) { alert("Cannot delete: doctor is assigned to a room."); return; }
    if (!window.confirm("Delete this doctor?")) return;
    const next = { ...state, doctorDirectory: { ...state.doctorDirectory } };
    delete next.doctorDirectory[id];
    await setState(next, { role: "DEVELOPER", action: "doctorDelete", id });
  };

  /* Room management */
  const addRoom = async () => {
    const id = newRoom.trim().toUpperCase();
    if (!id || (state.rooms || []).includes(id)) return;
    const rooms = [...(state.rooms || DEFAULT_ROOMS), id];
    const next = { ...state, rooms, assigned: { ...state.assigned, [id]: null }, sessions: { ...state.sessions, [id]: null }, nowServing: { ...state.nowServing, [id]: null }, upNext: { ...state.upNext, [id]: null }, customCall: { ...state.customCall, [id]: null }, status: { ...state.status, [id]: "IDLE" } };
    await setState(next, { role: "DEVELOPER", action: "addRoom", id });
    await addRoomCredential(id);
    setNewRoom("");
  };
  const removeRoom = async (id) => {
    if (!window.confirm(`Remove room ${id}?`)) return;
    const rooms = (state.rooms || []).filter((r) => r !== id);
    await setState({ ...state, rooms }, { role: "DEVELOPER", action: "removeRoom", id });
    await deleteRoomDoc(id);
    await removeRoomCredential(id);
  };

  /* Chime */
  const updateChime = async (patch) => {
    await setState({ ...state, chime: { ...state.chime, ...patch } }, { role: "DEVELOPER", action: "chimeUpdate" });
  };
  const testChime = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const vol = ctx.createGain(); vol.gain.value = state.chime?.volume ?? 0.22; vol.connect(ctx.destination);
      const beep = (t, f) => { const o = ctx.createOscillator(); o.type="sine"; o.frequency.value=f; o.connect(vol); o.start(t); o.stop(t+0.14); };
      const t0 = ctx.currentTime+0.01; beep(t0,880); beep(t0+0.22,1046);
    } catch {}
  };

  const doctors = Object.values(state.doctorDirectory || {});

  return (
    <div className="portal-bg">
      <div className="portal-container">
        <div className="portal-header">
          <div>
            <h1 className="portal-title">Developer Portal</h1>
            <div className="portal-sub">Full system control</div>
          </div>
          <div className="status-pill" style={{ background: "#7c3aed22", color: "#7c3aed" }}>🔐 Google Auth</div>
        </div>

        <div className="tab-bar">
          {["doctors","rooms","credentials","chime","branding","schedule","analytics"].map((t) => (
            <button key={t} className={`tab-btn${tab===t?" active":""}`} onClick={() => setTab(t)}>
              {t==="doctors"?"👤 Doctors":t==="rooms"?"🏥 Rooms":t==="credentials"?"🔑 Credentials":t==="chime"?"🔔 Chime":t==="branding"?"🎨 Branding":t==="schedule"?"🕐 Schedule":"📊 Analytics"}
            </button>
          ))}
        </div>

        {tab === "doctors" && (
          <div className="card">
            <h2 className="card-title">Doctor Directory</h2>
            <div className="add-row">
              <input className="field-input" placeholder="Full name" value={form.name} onChange={(e) => setForm({...form,name:e.target.value})} />
              <input className="field-input" placeholder="Specialty (optional)" value={form.specialty} onChange={(e) => setForm({...form,specialty:e.target.value})} />
              <button className="btn btn-green" onClick={addDoctor}>+ Add</button>
            </div>
            {doctors.length === 0 && <div className="dim">No doctors added yet.</div>}
            <div className="divide-list">
              {doctors.map((d) => (
                <div key={d.id} className="divide-row">
                  <div>
                    <div className="fw-med">{d.name}</div>
                    <div className="dim" style={{fontSize:"0.82rem"}}>{d.specialty||"General"} · <span style={{color:d.active?"#22c55e":"#ef4444"}}>{d.active?"Active":"Inactive"}</span></div>
                  </div>
                  <div className="btn-group">
                    <button className="btn btn-outline btn-sm" onClick={() => editDoctor(d.id)}>Edit</button>
                    <button className={`btn btn-sm ${d.active?"btn-yellow":"btn-green"}`} onClick={() => toggleDoctor(d.id,!d.active)}>{d.active?"Deactivate":"Reactivate"}</button>
                    <button className="btn btn-red btn-sm" onClick={() => deleteDoctor(d.id)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "rooms" && (
          <div className="card">
            <h2 className="card-title">Room Management</h2>
            <div className="add-row">
              <input className="field-input" placeholder="Room ID (e.g. R06)" value={newRoom} onChange={(e) => setNewRoom(e.target.value)} />
              <button className="btn btn-green" onClick={addRoom}>+ Add Room</button>
            </div>
            <div className="divide-list">
              {(state.rooms||DEFAULT_ROOMS).map((r) => (
                <div key={r} className="divide-row">
                  <div>
                    <div className="fw-med mono">{r}</div>
                    <div className="dim" style={{fontSize:"0.82rem"}}>{state.assigned[r]?.name||"Unassigned"} · {state.status[r]}</div>
                  </div>
                  <button className="btn btn-red btn-sm" onClick={() => removeRoom(r)}>Remove</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "credentials" && <CredentialsTab rooms={state.rooms||DEFAULT_ROOMS} />}

        {tab === "chime" && (
          <div className="card">
            <h2 className="card-title">Chime Settings</h2>
            <div className="chime-grid">
              <label className="toggle-row"><span>Enabled</span><input type="checkbox" checked={!!state.chime?.enabled} onChange={(e) => updateChime({enabled:e.target.checked})} /></label>
              <label className="toggle-row"><span>Do Not Disturb</span><input type="checkbox" checked={!!state.chime?.doNotDisturb} onChange={(e) => updateChime({doNotDisturb:e.target.checked})} /></label>
              <div className="field-group">
                <label className="field-label">Volume — {Math.round((state.chime?.volume??0.22)*100)}%</label>
                <input type="range" min="0" max="1" step="0.01" value={state.chime?.volume??0.22} onChange={(e) => updateChime({volume:parseFloat(e.target.value)})} style={{width:"100%"}} />
              </div>
              <div className="field-group">
                <label className="field-label">Quiet Hours</label>
                <div style={{display:"flex",gap:"0.5rem",alignItems:"center"}}>
                  <input type="time" className="field-input" style={{width:"auto"}} value={state.chime?.dndStart||"22:00"} onChange={(e) => updateChime({dndStart:e.target.value})} />
                  <span className="dim">to</span>
                  <input type="time" className="field-input" style={{width:"auto"}} value={state.chime?.dndEnd||"07:00"} onChange={(e) => updateChime({dndEnd:e.target.value})} />
                </div>
              </div>
              <div className="field-group">
                <label className="field-label">Min gap between chimes (sec)</label>
                <input type="number" className="field-input" style={{width:"80px"}} min="0" max="30" value={state.chime?.minGapSec??3} onChange={(e) => updateChime({minGapSec:parseInt(e.target.value)||0})} />
              </div>
              <button className="btn btn-blue" onClick={testChime}>🔔 Test Chime</button>
            </div>
          </div>
        )}

        {tab === "branding" && <BrandingTab />}
        {tab === "schedule" && <ScheduleTab state={state} setState={setState} />}
        {tab === "analytics" && <AnalyticsTab />}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   CREDENTIALS TAB — change passwords via Firestore auth doc
───────────────────────────────────────────── */
/* ─────────────────────────────────────────────
   BRANDING TAB — logo upload for lobby display
───────────────────────────────────────────── */
function BrandingTab() {
  const [logoUrl, setLogoUrl] = useState(null);
  const [splashUrl, setSplashUrl] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState("");
  const logoInputRef = useRef(null);
  const splashInputRef = useRef(null);

  useEffect(() => {
    getDownloadURL(ref(storage, LOGO_PATH)).then(setLogoUrl).catch(() => setLogoUrl(null));
    getDownloadURL(ref(storage, SPLASH_PATH)).then(setSplashUrl).catch(() => setSplashUrl(null));
  }, []);

  const upload = async (file, path, setUrl, label) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setMsg("Please select an image file."); return; }
    const maxMb = path === SPLASH_PATH ? 5 : 2;
    if (file.size > maxMb * 1024 * 1024) { setMsg(`File must be under ${maxMb}MB.`); return; }
    setUploading(true); setMsg("");
    try {
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file, { contentType: file.type });
      const url = await getDownloadURL(storageRef);
      setUrl(url);
      setMsg(`✓ ${label} uploaded. Lobby updates automatically.`);
    } catch (e) {
      setMsg("Upload failed: " + e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div className="card">
        <h2 className="card-title">Lobby Logo</h2>
        <p className="dim" style={{ fontSize: "0.83rem", marginBottom: "1.5rem" }}>
          Appears top-left of the live lobby. Recommended: PNG with transparent background.
        </p>
        <div style={{ display: "flex", gap: "2rem", alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1", minWidth: "200px" }}>
            <div className="field-label" style={{ marginBottom: "0.5rem" }}>Current logo</div>
            <div style={{ background: "#0d1119", borderRadius: "12px", padding: "1.5rem", minHeight: "100px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {logoUrl
                ? <img src={logoUrl} alt="Clinic logo" style={{ maxHeight: "80px", maxWidth: "200px", objectFit: "contain" }} />
                : <div style={{ color: "#ffffff44", fontSize: "0.85rem" }}>No logo — showing clinic name</div>
              }
            </div>
          </div>
          <div style={{ flex: "1", minWidth: "200px" }}>
            <div className="field-label" style={{ marginBottom: "0.5rem" }}>Upload new logo</div>
            <input ref={logoInputRef} type="file" accept="image/*" onChange={(e) => upload(e.target.files?.[0], LOGO_PATH, setLogoUrl, "Logo")} style={{ display: "none" }} />
            <button className="btn btn-blue" onClick={() => logoInputRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : "Choose image"}
            </button>
            <div className="dim" style={{ fontSize: "0.78rem", marginTop: "0.5rem" }}>PNG, JPG, SVG · max 2MB</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Closed / Opening-Hours Splash</h2>
        <p className="dim" style={{ fontSize: "0.83rem", marginBottom: "1.5rem" }}>
          Full-screen image shown on the TV outside opening hours. Design it with your opening hours included. A live clock and QR code overlay at the bottom automatically. Recommended: landscape, 1920×1080.
        </p>
        <div style={{ display: "flex", gap: "2rem", alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1", minWidth: "200px" }}>
            <div className="field-label" style={{ marginBottom: "0.5rem" }}>Current splash</div>
            <div style={{ background: "#0d1119", borderRadius: "12px", padding: "1rem", minHeight: "120px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {splashUrl
                ? <img src={splashUrl} alt="Splash" style={{ maxHeight: "160px", maxWidth: "100%", objectFit: "contain", borderRadius: "8px" }} />
                : <div style={{ color: "#ffffff44", fontSize: "0.85rem" }}>No splash — showing text fallback</div>
              }
            </div>
          </div>
          <div style={{ flex: "1", minWidth: "200px" }}>
            <div className="field-label" style={{ marginBottom: "0.5rem" }}>Upload splash image</div>
            <input ref={splashInputRef} type="file" accept="image/*" onChange={(e) => upload(e.target.files?.[0], SPLASH_PATH, setSplashUrl, "Splash")} style={{ display: "none" }} />
            <button className="btn btn-blue" onClick={() => splashInputRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : "Choose image"}
            </button>
            <div className="dim" style={{ fontSize: "0.78rem", marginTop: "0.5rem" }}>PNG, JPG · max 5MB</div>
          </div>
        </div>
        {msg && <div style={{ fontSize: "0.82rem", marginTop: "1rem", color: msg.startsWith("✓") ? "var(--green)" : "var(--red)" }}>{msg}</div>}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   SCHEDULE TAB — opening hours + auto-clear time
───────────────────────────────────────────── */
function ScheduleTab({ state, setState }) {
  const sched = state.schedule || DEFAULT_SCHEDULE;
  const update = async (patch) => {
    await setState({ ...state, schedule: { ...sched, ...patch } }, { role: "ADMIN", action: "scheduleUpdate" });
  };
  const open = isClinicOpen(sched);
  return (
    <div className="card">
      <h2 className="card-title">Opening Hours &amp; Daily Reset</h2>
      <p className="dim" style={{ fontSize: "0.83rem", marginBottom: "1.25rem" }}>
        The TV shows your splash image outside opening hours and the live queue during them.
        Status now: <strong style={{ color: open ? "var(--green)" : "var(--red)" }}>{open ? "OPEN (live queue)" : "CLOSED (splash)"}</strong>
      </p>
      <div className="chime-grid">
        <label className="toggle-row">
          <span>Enable scheduled splash</span>
          <input type="checkbox" checked={!!sched.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        </label>
        <div className="field-group">
          <label className="field-label">Opening time (splash → queue)</label>
          <input type="time" className="field-input" style={{ width: "auto" }} value={sched.openTime || "08:00"} onChange={(e) => update({ openTime: e.target.value })} />
        </div>
        <div className="field-group">
          <label className="field-label">Closing time (queue → splash)</label>
          <input type="time" className="field-input" style={{ width: "auto" }} value={sched.closeTime || "17:00"} onChange={(e) => update({ closeTime: e.target.value })} />
        </div>
        <div className="field-group">
          <label className="field-label">Daily token auto-clear time</label>
          <input type="time" className="field-input" style={{ width: "auto" }} value={sched.clearTime || "06:00"} onChange={(e) => update({ clearTime: e.target.value })} />
          <div className="dim" style={{ fontSize: "0.78rem", marginTop: "0.4rem" }}>Yesterday's tokens &amp; statuses reset at this time. Assignments stay.</div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   ANALYTICS TAB
───────────────────────────────────────────── */
function AnalyticsTab() {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(thirtyDaysAgo);
  const [to, setTo] = useState(today);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const q = query(
        SESSIONS_COL,
        where("date", ">=", from),
        where("date", "<=", to),
        orderBy("date", "desc"),
        limit(500)
      );
      const snap = await getDocs(q);
      setSessions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error("Analytics load failed:", e.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Aggregations
  const totalSessions = sessions.length;
  const totalTokens = sessions.reduce((s, r) => s + (r.tokensServed || 0), 0);
  const avgDuration = totalSessions
    ? Math.round(sessions.reduce((s, r) => s + (r.durationMin || 0), 0) / totalSessions)
    : 0;
  const avgTokens = totalSessions ? Math.round(totalTokens / totalSessions) : 0;

  // Per-doctor breakdown
  const byDoctor = {};
  sessions.forEach((s) => {
    const k = s.doctor || "Unknown";
    if (!byDoctor[k]) byDoctor[k] = { sessions: 0, tokens: 0, duration: 0 };
    byDoctor[k].sessions++;
    byDoctor[k].tokens += s.tokensServed || 0;
    byDoctor[k].duration += s.durationMin || 0;
  });

  // Busiest hours
  const byHour = Array(24).fill(0);
  sessions.forEach((s) => { if (s.startHour != null) byHour[s.startHour]++; });
  const maxHour = Math.max(...byHour, 1);
  const busiestHour = byHour.indexOf(Math.max(...byHour));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Date filter */}
      <div className="card">
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
          <div className="field-group" style={{ margin: 0 }}>
            <label className="field-label">From</label>
            <input type="date" className="field-input" style={{ width: "auto" }} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field-group" style={{ margin: 0 }}>
            <label className="field-label">To</label>
            <input type="date" className="field-input" style={{ width: "auto" }} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <button className="btn btn-blue" style={{ marginTop: "1rem" }} onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Apply"}
          </button>
        </div>
      </div>

      {/* Summary metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "0.75rem" }}>
        {[
          { label: "Total sessions", value: totalSessions },
          { label: "Tokens served", value: totalTokens },
          { label: "Avg duration", value: `${avgDuration} min` },
          { label: "Avg tokens/session", value: avgTokens },
          { label: "Busiest hour", value: totalSessions ? `${busiestHour}:00` : "—" },
        ].map((m) => (
          <div key={m.label} style={{ background: "var(--bg)", borderRadius: "10px", padding: "1rem" }}>
            <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: "0.4rem" }}>{m.label}</div>
            <div style={{ fontSize: "1.6rem", fontWeight: 600, fontFamily: "'Space Grotesk', sans-serif" }}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* Hourly heatmap */}
      <div className="card">
        <h2 className="card-title">Sessions by hour</h2>
        <div style={{ display: "flex", gap: "3px", alignItems: "flex-end", height: "80px" }}>
          {byHour.map((count, h) => (
            <div key={h} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
              <div style={{
                width: "100%", borderRadius: "3px 3px 0 0",
                background: count > 0 ? `rgba(37,99,235,${0.2 + 0.8 * count / maxHour})` : "var(--border)",
                height: `${Math.max(4, (count / maxHour) * 60)}px`,
                transition: "height 0.3s",
              }} title={`${h}:00 — ${count} session${count !== 1 ? "s" : ""}`} />
              {h % 6 === 0 && <div style={{ fontSize: "0.6rem", color: "var(--text-dim)" }}>{h}h</div>}
            </div>
          ))}
        </div>
      </div>

      {/* Per-doctor breakdown */}
      <div className="card">
        <h2 className="card-title">Per-doctor breakdown</h2>
        {Object.keys(byDoctor).length === 0
          ? <div className="dim">No sessions in this date range.</div>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Doctor</th><th>Sessions</th><th>Tokens</th><th>Total time</th><th>Avg tokens</th></tr>
                </thead>
                <tbody>
                  {Object.entries(byDoctor)
                    .sort((a, b) => b[1].tokens - a[1].tokens)
                    .map(([name, d]) => (
                      <tr key={name}>
                        <td style={{ fontWeight: 500 }}>{name}</td>
                        <td>{d.sessions}</td>
                        <td>{d.tokens}</td>
                        <td>{d.duration} min</td>
                        <td>{Math.round(d.tokens / d.sessions)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>

      {/* Session history table */}
      <div className="card">
        <h2 className="card-title">Session history</h2>
        {sessions.length === 0
          ? <div className="dim">No sessions found.</div>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Date</th><th>Room</th><th>Doctor</th><th>Start</th><th>Duration</th><th>Tokens</th></tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: "0.8rem" }}>{s.date}</td>
                      <td className="mono">{s.room}</td>
                      <td>{s.doctor}</td>
                      <td className="dim" style={{ fontSize: "0.8rem" }}>
                        {s.startedAt?.toDate ? s.startedAt.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                      </td>
                      <td>{s.durationMin} min</td>
                      <td style={{ fontWeight: 600 }}>{s.tokensServed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   CRED CARD — extracted to prevent remount/focus loss
───────────────────────────────────────────── */
function CredCard({ label, credKey, role, room, forms, setField, save, saving, msg }) {
  const form = forms[credKey] || { username: "", password: "", confirm: "" };
  const feedback = msg[credKey] || "";
  const isSuccess = feedback.startsWith("✓");
  return (
    <div className="cred-card">
      <div className="cred-room">{label}</div>
      <div className="field-group">
        <label className="field-label">Username</label>
        <input className="field-input" value={form.username}
          onChange={(e) => setField(credKey, "username", e.target.value)} />
      </div>
      <div className="field-group">
        <label className="field-label">New password</label>
        <input className="field-input" type="password" value={form.password}
          onChange={(e) => setField(credKey, "password", e.target.value)}
          autoComplete="new-password" />
      </div>
      <div className="field-group">
        <label className="field-label">Confirm password</label>
        <input className="field-input" type="password" value={form.confirm}
          onChange={(e) => setField(credKey, "confirm", e.target.value)}
          autoComplete="new-password" />
      </div>
      {feedback && <div style={{ fontSize: "0.8rem", marginBottom: "0.5rem", color: isSuccess ? "var(--green)" : "var(--red)" }}>{feedback}</div>}
      <button className="btn btn-blue btn-sm" onClick={() => save(role, room)} disabled={saving === credKey}>
        {saving === credKey ? "Saving…" : "Update credentials"}
      </button>
    </div>
  );
}

function CredentialsTab({ rooms }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [msg, setMsg] = useState({});
  const [forms, setForms] = useState({});

  useEffect(() => {
    fetchCredentials().then((c) => {
      setLoading(false);
      if (c) {
        const init = {
          superadmin: { username: c.superadmin?.username || "", password: "", confirm: "" },
          admin:      { username: c.admin?.username || "", password: "", confirm: "" },
        };
        rooms.forEach((r) => {
          init[r] = { username: c.rooms?.[r]?.username || "", password: "", confirm: "" };
        });
        setForms(init);
      }
    }).catch(() => setLoading(false));
  }, [rooms]);

  const setField = (key, field, value) =>
    setForms((f) => ({ ...f, [key]: { ...f[key], [field]: value } }));

  const save = async (role, room = null) => {
    const key = room || role.toLowerCase();
    const form = forms[key] || {};
    if (!form.username.trim()) { setMsg((m) => ({ ...m, [key]: "Username required." })); return; }
    if (!form.password) { setMsg((m) => ({ ...m, [key]: "Password required." })); return; }
    if (form.password !== form.confirm) { setMsg((m) => ({ ...m, [key]: "Passwords do not match." })); return; }
    if (form.password.length < 6) { setMsg((m) => ({ ...m, [key]: "Password must be at least 6 characters." })); return; }
    setSaving(key);
    try {
      await changePassword(role, form.username.trim(), form.password, room);
      setMsg((m) => ({ ...m, [key]: "✓ Saved successfully." }));
      setForms((f) => ({ ...f, [key]: { ...f[key], password: "", confirm: "" } }));
    } catch (e) {
      setMsg((m) => ({ ...m, [key]: "Error: " + e.message }));
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <div className="card dim">Loading credentials…</div>;

  const shared = { forms, setField, save, saving, msg };

  return (
    <div className="card">
      <h2 className="card-title">Change Credentials</h2>
      <p className="dim" style={{ fontSize: "0.83rem", marginBottom: "1.25rem" }}>
        Passwords are hashed with SHA-256 before storage. Minimum 6 characters.
      </p>
      <h3 style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.75rem", color: "var(--text-dim)" }}>SYSTEM ACCOUNTS</h3>
      <div className="cred-grid" style={{ marginBottom: "1.5rem" }}>
        <CredCard label="Super-Admin" credKey="superadmin" role="SUPERADMIN" {...shared} />
        <CredCard label="Admin" credKey="admin" role="ADMIN" {...shared} />
      </div>
      <h3 style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.75rem", color: "var(--text-dim)" }}>ROOM ACCOUNTS</h3>
      <div className="cred-grid">
        {rooms.map((r) => (
          <CredCard key={r} label={r} credKey={r} role="DOCTOR" room={r} {...shared} />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   GLOBAL CSS
───────────────────────────────────────────── */
const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow-x: hidden; }
#root { height: 100%; }

:root {
  --bg: #f4f5f7;
  --surface: #ffffff;
  --border: #e2e5ea;
  --text: #111827;
  --text-dim: #6b7280;
  --blue: #2563eb;
  --green: #16a34a;
  --red: #dc2626;
  --yellow: #d97706;
  --radius: 12px;
  --shadow: 0 1px 4px rgba(0,0,0,0.07), 0 4px 16px rgba(0,0,0,0.05);
}

body { font-family: 'DM Sans', sans-serif; background: var(--bg); color: var(--text); }

.page-wrap { min-height: calc(100vh - 48px); }

/* NAV */
.topnav {
  height: 48px; background: #0f1117; color: #fff;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 1.25rem; position: sticky; top: 0; z-index: 100;
  border-bottom: 1px solid #ffffff14;
}
.topnav-brand {
  font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 1rem;
  display: flex; align-items: center; gap: 0.5rem; cursor: pointer; letter-spacing: -0.01em;
}
.topnav-ver { font-size: 0.72rem; opacity: 0.4; font-weight: 400; }
.topnav-links { display: flex; gap: 1.25rem; }
.topnav-links a { font-size: 0.82rem; color: #ffffffaa; cursor: pointer; text-decoration: none; transition: color 0.15s; }
.topnav-links a:hover { color: #fff; }
.topnav-links a.logout { color: #f87171; }

/* LOBBY */
.lobby { min-height: 100vh; background: #060810; color: #fff; padding: 1.5rem; }
.lobby:fullscreen { min-height: 100vh; padding: 2rem; margin: 0; }
.lobby-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 2rem; padding-bottom: 1.25rem; border-bottom: 1px solid #ffffff10;
}
.lobby-title {
  font-family: 'Space Grotesk', sans-serif; font-size: 1.5rem; font-weight: 700;
  display: flex; align-items: center; gap: 0.6rem;
}
.lobby-pulse {
  display: inline-block; width: 10px; height: 10px; border-radius: 50%;
  background: #22c55e; box-shadow: 0 0 0 0 #22c55e88;
  animation: pulse 1.8s ease-in-out infinite;
}
@keyframes pulse {
  0%,100% { box-shadow: 0 0 0 0 #22c55e88; }
  50% { box-shadow: 0 0 0 10px transparent; }
}
.lobby-clock { text-align: right; }
.lobby-time { font-family: 'JetBrains Mono', monospace; font-size: 2rem; font-weight: 500; letter-spacing: 0.06em; }
.lobby-date { font-size: 0.8rem; opacity: 0.4; margin-top: 4px; letter-spacing: 0.02em; }
.lobby-fs-btn {
  background: #ffffff0a; border: 1px solid #ffffff18; color: #fff;
  border-radius: 10px; padding: 0.5rem 0.75rem; cursor: pointer;
  font-size: 1.2rem; line-height: 1; text-align: center; transition: background 0.15s;
}
.lobby-fs-btn:hover { background: #ffffff18; }
.lobby-loading, .lobby-empty { text-align: center; padding: 6rem; opacity: 0.3; display: flex; align-items: center; justify-content: center; gap: 1rem; font-size: 1.1rem; }
.spinner { width: 24px; height: 24px; border: 2px solid #ffffff22; border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.lobby-grid { display: grid; gap: 1.25rem; }
.lobby-grid-1 { grid-template-columns: 1fr; max-width: 600px; margin: 0 auto; }
.lobby-grid-2 { grid-template-columns: repeat(2, 1fr); }
.lobby-grid-3 { grid-template-columns: repeat(3, 1fr); }
.lobby-grid-4 { grid-template-columns: repeat(4, 1fr); }

/* Tablet — drop to 2 columns */
@media (max-width: 900px) {
  .lobby-grid-3, .lobby-grid-4 { grid-template-columns: repeat(2, 1fr); }
}

/* Phone — single column, stacked, header wraps */
@media (max-width: 600px) {
  .lobby { padding: 1rem; }
  .lobby-grid, .lobby-grid-1, .lobby-grid-2, .lobby-grid-3, .lobby-grid-4 {
    grid-template-columns: 1fr; max-width: 100%;
  }
  .lobby-header { flex-wrap: wrap; gap: 1rem; margin-bottom: 1.25rem; }
  .lobby-brand { min-width: auto; flex: 1; }
  .lobby-center { order: 3; width: 100%; justify-content: flex-start; }
  .lobby-time { font-size: 1.4rem; }
  .lobby-logo-img { max-height: 44px; max-width: 160px; }
  .lobby-logo-text { font-size: 1.1rem; }
  .lobby-room-id { font-size: 1.4rem; }
  .lobby-doctor { font-size: 1.05rem; }
  .lobby-token-num { font-size: 3rem; }
  .lobby-token-next, .lobby-token-waiting { font-size: 1.8rem !important; }
  .lobby-card { padding: 1.25rem; }
  /* Hide the QR + fullscreen on phone — they're already on it */
  .lobby-right { display: none; }
}

.lobby-card {
  background: #0d1119; border: 1px solid var(--accent, #ffffff12);
  border-radius: 20px; padding: 1.75rem; position: relative; overflow: hidden;
  transition: border-color 0.3s;
}
.lobby-card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
  background: var(--accent, #1e293b); border-radius: 20px 20px 0 0;
}
.lobby-card-flash {
  animation: cardFlash 1.2s ease-out;
}
@keyframes cardFlash {
  0%   { background: #1a2a1a; border-color: #22c55e; }
  40%  { background: #111d11; border-color: #22c55e88; }
  100% { background: #0d1119; border-color: var(--accent, #ffffff12); }
}
.lobby-card-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.6rem; }
.lobby-room-id { font-family: 'Space Grotesk', sans-serif; font-size: 1.8rem; font-weight: 700; letter-spacing: -0.02em; }
.lobby-status-badge { font-size: 0.68rem; font-weight: 700; padding: 4px 10px; border-radius: 100px; letter-spacing: 0.06em; }
.lobby-doctor { font-size: 1.25rem; font-weight: 600; margin-bottom: 2px; }
.lobby-dept { font-size: 0.8rem; opacity: 0.4; margin-bottom: 1.5rem; letter-spacing: 0.02em; }
.lobby-token-row { display: flex; align-items: stretch; gap: 1rem; }
.lobby-token-block { flex: 1; }
.lobby-divider { width: 1px; background: #ffffff0f; flex-shrink: 0; }
.lobby-token-label { font-size: 0.6rem; letter-spacing: 0.12em; opacity: 0.35; margin-bottom: 0.4rem; font-weight: 700; text-transform: uppercase; }
.lobby-token-num { font-family: 'Space Grotesk', sans-serif; font-size: 4.5rem; font-weight: 700; line-height: 1; }
.lobby-token-animate { animation: tokenPop 0.5s cubic-bezier(0.34,1.56,0.64,1); }
@keyframes tokenPop {
  0%   { transform: scale(0.7); opacity: 0.3; color: #22c55e; }
  60%  { transform: scale(1.15); }
  100% { transform: scale(1); opacity: 1; }
}
.lobby-token-next    { font-size: 2.5rem !important; opacity: 0.45; }
.lobby-token-waiting { font-size: 2.5rem !important; opacity: 0.35; }
.lobby-brand { display: flex; align-items: center; min-width: 200px; }
.lobby-center { flex: 1; display: flex; justify-content: center; }
.lobby-right { display: flex; align-items: center; gap: 1rem; }
.lobby-logo-wrap { display: flex; align-items: center; }
.lobby-logo-img { max-height: 60px; max-width: 220px; object-fit: contain; filter: brightness(1.1); }
.lobby-logo-text { font-family: 'Space Grotesk', sans-serif; font-size: 1.4rem; font-weight: 700; letter-spacing: -0.02em; }
.lobby-qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.lobby-qr-label { font-size: 0.6rem; opacity: 0.35; letter-spacing: 0.06em; text-transform: uppercase; }

/* CLOSED SPLASH */
.splash { position: relative; width: 100%; min-height: 100vh; background: #060810; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.splash-img { width: 100%; height: 100vh; object-fit: contain; display: block; }
.splash-fallback { text-align: center; color: #fff; }
.splash-logo { font-family: 'Space Grotesk', sans-serif; font-size: 2.5rem; font-weight: 700; margin-bottom: 1rem; }
.splash-closed { font-size: 1.5rem; opacity: 0.5; text-transform: uppercase; letter-spacing: 0.2em; margin-bottom: 0.5rem; }
.splash-hours { font-size: 1.1rem; opacity: 0.6; }
.splash-overlay { position: absolute; bottom: 1.5rem; left: 0; right: 0; display: flex; align-items: flex-end; justify-content: space-between; padding: 0 2rem; pointer-events: none; }
.splash-clock { font-family: 'JetBrains Mono', monospace; font-size: 1.4rem; font-weight: 500; color: #fff; opacity: 0.7; letter-spacing: 0.04em; background: #00000055; padding: 6px 12px; border-radius: 8px; }
@media (max-width: 600px) {
  .splash-img { height: auto; max-height: 100vh; }
  .splash-overlay { padding: 0 1rem; bottom: 1rem; }
  .splash-clock { font-size: 1.1rem; }
}

/* PORTALS */
.portal-bg { min-height: calc(100vh - 48px); background: var(--bg); padding: 2rem 1rem; }
.portal-container { max-width: 860px; margin: 0 auto; }
.portal-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; }
.portal-title { font-family: 'Space Grotesk', sans-serif; font-size: 1.6rem; font-weight: 700; }
.portal-sub { font-size: 0.85rem; color: var(--text-dim); margin-top: 2px; }

/* LOGIN */
.login-card {
  max-width: 400px; margin: 3rem auto; background: var(--surface);
  border-radius: var(--radius); border: 1px solid var(--border); padding: 2rem;
  box-shadow: var(--shadow);
}
.login-logo {
  font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; font-weight: 700;
  display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.5rem;
}
.login-title { font-size: 1.3rem; font-weight: 600; margin-bottom: 1.25rem; }
.login-err { color: #ef4444; font-size: 0.83rem; margin-bottom: 0.75rem; }

/* TABS */
.tab-bar { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
.tab-btn {
  padding: 0.45rem 1rem; border-radius: 8px; font-size: 0.85rem; font-weight: 500;
  border: 1px solid var(--border); background: var(--surface); color: var(--text-dim);
  cursor: pointer; transition: all 0.15s;
}
.tab-btn:hover { background: #f0f2f5; }
.tab-btn.active { background: #1e293b; color: #fff; border-color: #1e293b; }

/* CARDS */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.5rem; box-shadow: var(--shadow); margin-bottom: 1rem; }
.card-title { font-weight: 600; font-size: 1rem; margin-bottom: 1rem; }

/* FORMS */
.field-group { margin-bottom: 0.75rem; }
.field-label { display: block; font-size: 0.8rem; font-weight: 500; color: var(--text-dim); margin-bottom: 0.3rem; }
.field-input {
  width: 100%; padding: 0.45rem 0.75rem; border: 1px solid var(--border);
  border-radius: 8px; font-size: 0.9rem; font-family: inherit;
  background: var(--surface); color: var(--text); outline: none;
  transition: border-color 0.15s;
}
.field-input:focus { border-color: var(--blue); }
select.field-input { cursor: pointer; }

/* BUTTONS */
.btn {
  padding: 0.5rem 1.1rem; border-radius: 8px; font-size: 0.88rem; font-weight: 500;
  font-family: inherit; cursor: pointer; border: none; transition: all 0.15s; white-space: nowrap;
}
.btn:hover { filter: brightness(1.08); }
.btn:active { transform: scale(0.98); }
.btn-primary { background: var(--blue); color: #fff; }
.btn-blue { background: var(--blue); color: #fff; }
.btn-green { background: var(--green); color: #fff; }
.btn-red { background: var(--red); color: #fff; }
.btn-yellow { background: var(--yellow); color: #fff; }
.btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border); }
.btn-sm { padding: 0.3rem 0.75rem; font-size: 0.8rem; }
.w-full { width: 100%; }

/* DOCTOR PORTAL */
.doctor-token-display {
  background: #0f1117; color: #fff; border-radius: var(--radius); padding: 1.5rem 2rem;
  display: flex; gap: 2rem; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap;
}
.doctor-token-block { text-align: center; }
.doctor-token-label { font-size: 0.65rem; letter-spacing: 0.1em; opacity: 0.45; font-weight: 600; margin-bottom: 0.4rem; }
.doctor-token-big { font-family: 'Space Grotesk', sans-serif; font-size: 3.5rem; font-weight: 700; line-height: 1; }
.doctor-token-sep { width: 1px; background: #ffffff18; align-self: stretch; }
.doctor-actions { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem 1.5rem; }
.action-section-title { font-size: 0.72rem; font-weight: 600; color: var(--text-dim); letter-spacing: 0.07em; text-transform: uppercase; margin: 1rem 0 0.5rem; }
.action-section-title:first-child { margin-top: 0; }
.action-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }

/* STATUS */
.status-pill { font-size: 0.75rem; font-weight: 600; padding: 3px 10px; border-radius: 100px; letter-spacing: 0.03em; }

/* TABLES */
.table-wrap { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
.data-table th { text-align: left; padding: 0.5rem 0.75rem; font-size: 0.75rem; font-weight: 600; color: var(--text-dim); border-bottom: 1px solid var(--border); }
.data-table td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); }
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:hover td { background: #f9fafb; }

/* MISC */
.room-assign-grid { display: flex; flex-direction: column; gap: 0.6rem; }
.room-assign-row { display: flex; align-items: center; gap: 0.6rem; }
.room-assign-id { font-family: 'JetBrains Mono', monospace; font-weight: 600; min-width: 44px; font-size: 0.88rem; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
.stat-card { background: #f9fafb; border: 1px solid var(--border); border-radius: 10px; padding: 1rem; }
.stat-room { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 1.1rem; margin-bottom: 0.2rem; }
.stat-doctor { font-size: 0.85rem; font-weight: 500; margin-bottom: 0.75rem; color: var(--text-dim); }
.stat-row { display: flex; justify-content: space-between; font-size: 0.83rem; padding: 0.25rem 0; border-top: 1px solid var(--border); }
.cred-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
.cred-card { background: #f9fafb; border: 1px solid var(--border); border-radius: 10px; padding: 1rem; }
.cred-room { font-family: 'JetBrains Mono', monospace; font-weight: 700; margin-bottom: 0.75rem; }
.chime-grid { display: flex; flex-direction: column; gap: 1rem; }
.toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; font-size: 0.9rem; cursor: pointer; }
.add-row { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
.add-row .field-input { flex: 1; min-width: 140px; }
.divide-list { display: flex; flex-direction: column; }
.divide-row { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid var(--border); gap: 1rem; }
.divide-row:last-child { border-bottom: none; }
.btn-group { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.fw-med { font-weight: 500; }
.dim { color: var(--text-dim); }
.mono { font-family: 'JetBrains Mono', monospace; }
.btn-google { background: var(--surface); color: var(--text); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; }
.btn-google:hover { background: #f9fafb; }
.login-divider { display: flex; align-items: center; gap: 0.75rem; margin: 1rem 0; color: var(--text-dim); font-size: 0.8rem; }
.login-divider::before, .login-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
`;
