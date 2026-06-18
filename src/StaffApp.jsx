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
import { db, storage, APP_URL, functions } from "./firebase.js";
import { httpsCallable } from "firebase/functions";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { onAuthChange, logout as logout_, signInWithGoogle, completeGoogleRedirect } from "./auth.js";

const CONFIG_DOC = doc(db, "clinicq", "config");
const ROOMS_COL = collection(db, "clinicq_rooms");
const AUDIT_COL = collection(db, "clinicq_audit");
const SESSIONS_COL = collection(db, "clinicq_sessions");
const STAFF_DOC = doc(db, "clinicq", "staff");
const PATIENTS_COL = collection(db, "clinicq_patients");
const VISITS_COL = collection(db, "clinicq_visits");

const roomDoc = (id) => doc(db, "clinicq_rooms", id);

// Per-room operational fields (live in clinicq_rooms/{id})
const ROOM_FIELDS = ["assigned", "sessions", "nowServing", "upNext", "customCall", "status"];
// Config fields (live in clinicq/config)
const CONFIG_FIELDS = ["rooms", "doctorDirectory", "chime", "schedule", "adminEmails", "lobbyTheme"];

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
  adminEmails: [],    // Google emails that get ADMIN role
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
  try { await deleteDoc(roomDoc(roomId)); } catch (e) { console.warn("deleteRoomDoc:", e.message); }
}

async function logAudit(entry) {
  try {
    await addDoc(AUDIT_COL, { ...entry, ts: serverTimestamp() });
  } catch (e) { console.warn("logAudit:", e.message); }
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
  const [config, setConfig] = useState({ rooms: DEFAULT_ROOMS, doctorDirectory: {}, chime: DEFAULT_STATE.chime, schedule: DEFAULT_SCHEDULE, adminEmails: [], lobbyTheme: "dark" });
  const [roomsData, setRoomsData] = useState({}); // roomId → { assigned, sessions, ... }
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const configRef = useRef(config);
  const roomsRef = useRef(roomsData);
  const lastUpdateRef = useRef(Date.now());
  configRef.current = config;
  roomsRef.current = roomsData;

  // Browser-level online/offline
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Subscribe to config doc
  useEffect(() => {
    const unsub = onSnapshot(CONFIG_DOC, { includeMetadataChanges: true }, (snap) => {
      // fromCache + no pending writes after initial load = likely disconnected
      if (!snap.metadata.fromCache) {
        setOnline(true);
        lastUpdateRef.current = Date.now();
      }
      const data = snap.exists() ? snap.data() : {};
      setConfig({
        rooms: data.rooms || DEFAULT_ROOMS,
        doctorDirectory: data.doctorDirectory || {},
        chime: { ...DEFAULT_STATE.chime, ...(data.chime || {}) },
        schedule: { ...DEFAULT_SCHEDULE, ...(data.schedule || {}) },
        adminEmails: data.adminEmails || [],
        lobbyTheme: data.lobbyTheme || "dark",
      });
      setReady(true);
    }, () => setOnline(false));
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
      adminEmails: config.adminEmails || [],
      lobbyTheme: config.lobbyTheme || "dark",
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
      await pushConfig({ rooms: next.rooms, doctorDirectory: next.doctorDirectory, chime: next.chime, schedule: next.schedule, adminEmails: next.adminEmails || [], lobbyTheme: next.lobbyTheme || "dark" });
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

  return { state, setState, setRoom, ready, online };
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
    case "CALLING":         return "#3b82f6";
    case "RECALL":          return "#f59e0b";
    case "PAUSED":          return "#f97316";
    case "SESSION ENDED":   return "#ef4444";
    default:                return "#64748b";
  }
}

function friendlyStatus(s) {
  switch (s) {
    case "SESSION STARTED": return "Open";
    case "CALLING":         return "Now Serving";
    case "RECALL":          return "Please Return";
    case "PAUSED":          return "On Break";
    case "SESSION ENDED":   return "Closed";
    case "IDLE":            return "Ready";
    default:                return s || "Ready";
  }
}

// Format room id → display name: R01 → Room 01
function roomDisplay(id) {
  if (!id) return id;
  const m = id.match(/^([A-Za-z]+)(\d+)$/);
  if (m) return m[1].toUpperCase().replace(/^R$/, "Room") + " " + m[2].padStart(2, "0");
  return id;
}

// Estimate wait time in minutes for a given room
function estimateWait(state, roomId) {
  const sess = state.sessions?.[roomId];
  const nowServing = state.nowServing?.[roomId];
  const nextToken = state.upNext?.[roomId];
  if (!sess?.startedAt || !nowServing || sess.served < 3) return null;
  const avgMin = Math.round((Date.now() - sess.startedAt) / 60000 / sess.served);
  if (avgMin <= 0) return null;
  return avgMin;
}

/* ═══════════════════════════════════════════
   APP ROOT
═══════════════════════════════════════════ */
export default function StaffApp() {
  const { role, room, loading } = useAuth();
  const [page, setPage] = useState(() => window.location.hash.replace("#", "").split("?")[0] || "login");

  useEffect(() => {
    const onHash = () => setPage(window.location.hash.replace("#", "").split("?")[0] || "login");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Complete Google redirect sign-in
  useEffect(() => {
    completeGoogleRedirect().then((r) => {
      if (r?.success) { /* auth state listener handles nav */ }
    }).catch(() => {});
  }, []);

  // Unauthenticated → back to login
  useEffect(() => {
    if (loading) return;
    const protected_ = ["doctor", "admin", "reception", "developer"];
    if (protected_.includes(page) && !role) { navigate("login"); return; }
    if (page === "doctor"    && role && role !== "DOCTOR")       { navigate("login"); }
    if (page === "reception" && role && role !== "RECEPTIONIST") { navigate("login"); }
    if (page === "admin"     && role && role !== "ADMIN")        { navigate("login"); }
    if (page === "developer" && role && role !== "DEVELOPER")    { navigate("login"); }
  }, [page, role, loading]);

  // After login → route to correct portal
  useEffect(() => {
    if (loading || !role) return;
    if (page === "login") {
      navigate(
        role === "DEVELOPER"    ? "developer" :
        role === "ADMIN"        ? "admin" :
        role === "RECEPTIONIST" ? "reception" : "doctor"
      );
    }
  }, [role, loading]);

  const navigate = (p) => {
    window.location.hash = p;
    setPage(p);
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

  const showNav = !["login"].includes(page);

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      {showNav && <TopNav navigate={navigate} role={role} room={room} />}
      <div className={showNav ? "page-wrap" : ""}>
        {page === "login"     && <LoginPage navigate={navigate} />}
        {page === "doctor"    && role === "DOCTOR"       && <DoctorPortal room={room} />}
        {page === "admin"     && role === "ADMIN"        && <AdminPortal />}
        {page === "reception" && role === "RECEPTIONIST" && <ReceptionPortal />}
        {page === "developer" && role === "DEVELOPER"    && <DeveloperPortal />}
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────
   TOP NAV
───────────────────────────────────────────── */
function TopNav({ navigate, role, room }) {
  const logout = async () => {
    await logout_();
    // Hard redirect to lobby — clears all React state cleanly
    window.location.href = "/login";
  };

  return (
    <nav className="topnav">
      <span className="topnav-brand">
        <span className="topnav-dot" />
        ClinicQ <span className="topnav-ver">v{APP_VERSION}</span>
      </span>
      <div className="topnav-links">
        {role === "DOCTOR" && <a onClick={() => navigate("doctor")}>Doctor {room ? `· ${room}` : ""}</a>}
        {role === "ADMIN" && <a onClick={() => navigate("admin")}>Admin</a>}
        {role === "RECEPTIONIST" && <a onClick={() => navigate("reception")}>Reception</a>}
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
function LobbyQR({ url, dark = true }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    import("qrcode").then((QRCode) => {
      QRCode.toCanvas(canvas, url, {
        width: 80, margin: 1,
        color: dark
          ? { dark: "#ffffff", light: "#00000000" }
          : { dark: "#000000", light: "#ffffff" },
      });
    }).catch(() => {});
  }, [url, dark]);
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
function LobbyCard({ id, state, theme }) {
  const doc = state.assigned[id];
  const s = state.status[id];
  const token = state.customCall[id] ?? state.nowServing[id];
  const next = state.upNext[id];
  const returnTime = state.sessions?.[id]?.returnTime || null;
  const [flash, setFlash] = useState(false);
  const prevToken = useRef(token);
  const isDark = theme === "dark";

  useEffect(() => {
    if (prevToken.current !== token) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1200);
      prevToken.current = token;
      return () => clearTimeout(t);
    }
  }, [token]);

  const isPaused = s === "PAUSED";
  const avgWait = estimateWait(state, id);
  const ahead = next != null && token != null ? Math.max(0, next - token - 1) : null;
  const waitStr = avgWait && ahead != null && ahead >= 0
    ? ahead === 0 ? "Your turn soon" : `~${ahead * avgWait} min wait`
    : null;

  return (
    <div className={`lobby-card${flash ? " lobby-card-flash" : ""}${isDark ? "" : " lobby-card-light"}`}
      style={{ "--accent": statusColor(s) }}>
      <div className="lobby-card-top">
        <div className="lobby-room-id">{roomDisplay(id)}</div>
        <div className="lobby-status-badge" style={{ background: statusColor(s) + "33", color: statusColor(s) }}>
          {friendlyStatus(s)}
        </div>
      </div>
      <div className="lobby-doctor-name">{doc?.name}</div>
      <div className="lobby-dept">{doc?.department || "General"}</div>

      {isPaused ? (
        <div className="lobby-break-box">
          <div className="lobby-break-icon">☕</div>
          <div className="lobby-break-text">On Break</div>
          {returnTime && <div className="lobby-break-return">Back at {returnTime}</div>}
        </div>
      ) : (
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
        </div>
      )}
      {waitStr && !isPaused && (
        <div className="lobby-wait-estimate">{waitStr}</div>
      )}
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
  const { state, setRoom, ready, online } = useClinicState();
  const [tick, setTick] = useState(0);
  const lobbyRef = useRef(null);
  const lastClearRef = useRef(null);
  const theme = state.lobbyTheme || "dark";

  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  // Daily auto-clear
  useEffect(() => {
    if (!ready || !state.schedule?.enabled) return;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const clearAt = hhmmToMin(state.schedule.clearTime || "06:00");
    const todayKey = now.toISOString().slice(0, 10);
    const storedKey = localStorage.getItem("cq_last_clear");
    if (cur >= clearAt && cur < clearAt + 2 && storedKey !== todayKey && lastClearRef.current !== todayKey) {
      lastClearRef.current = todayKey;
      localStorage.setItem("cq_last_clear", todayKey);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      (state.rooms || DEFAULT_ROOMS).forEach(async (id) => {
        if (state.status[id] !== "IDLE" || state.nowServing[id] != null) {
          setRoom(id, { sessions: null, nowServing: null, upNext: null, customCall: null, status: "IDLE" },
            { role: "SYSTEM", action: "dailyAutoClear", room: id });
        }
        // Clear any leftover waiting visits from yesterday
        try {
          const q = query(VISITS_COL, where("room", "==", id), where("date", "==", yesterday), where("status", "==", "waiting"));
          const snap = await getDocs(q);
          await Promise.all(snap.docs.map((d) => setDoc(doc(db, "clinicq_visits", d.id), { status: "cleared" }, { merge: true })));
        } catch {}
      });
    }
  }, [tick, ready]);

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const isDark = theme === "dark";

  if (ready && !isClinicOpen(state.schedule)) {
    return (
      <div className={`lobby lobby-${theme}`} ref={lobbyRef} style={{ padding: 0 }}>
        <ClosedSplash schedule={state.schedule} />
      </div>
    );
  }

  const rooms = (state.rooms || DEFAULT_ROOMS).filter((id) => state.assigned[id]);

  return (
    <div className={`lobby lobby-${theme}`} ref={lobbyRef}>
      {!online && (
        <div className="offline-banner">
          <span className="offline-dot" />
          Connection lost — display may be outdated
        </div>
      )}

      {/* Top bar: logo + connection dot + theme toggle */}
      <div className="lobby-topbar">
        <LobbyLogo />
        <span className={`conn-dot ${online ? "conn-online" : "conn-offline"}`} title={online ? "Connected" : "Disconnected"} />
      </div>

      {/* Room cards */}
      {!ready && <div className="lobby-loading"><div className="spinner" /><span>Connecting…</span></div>}
      {ready && rooms.length === 0 && <div className="lobby-empty">No active rooms at this time.</div>}
      {ready && rooms.length > 0 && (
        <div className={`lobby-grid lobby-grid-${Math.min(rooms.length, 4)}`}>
          {rooms.map((id) => <LobbyCard key={id} id={id} state={state} theme={theme} />)}
        </div>
      )}

      {/* Bottom bar: clock + QR */}
      <div className="lobby-bottombar">
        <div className="lobby-clock-bottom">
          <div className="lobby-time">{timeStr}</div>
          <div className="lobby-date">{dateStr}</div>
        </div>
        <LobbyQR url={APP_URL} dark={isDark} />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   LOGIN — credentials verified against Firestore
───────────────────────────────────────────── */
/* ─────────────────────────────────────────────
   LOGIN — Staff (Doctor + Reception)
   URL: /#login — email + password
───────────────────────────────────────────── */
function LoginPage({ navigate }) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (loading) return;
    if (!email.trim()) { setErr("Please enter your email."); return; }
    if (!pass) { setErr("Please enter your password."); return; }
    setErr(""); setLoading(true);
    try {
      const { signInWithEmailAndPassword } = await import("firebase/auth");
      const { auth } = await import("./firebase.js");
      await signInWithEmailAndPassword(auth, email.trim(), pass);
      // Auth state change triggers redirect via useEffect in App root
    } catch (e) {
      const code = e.code || "";
      if (code.includes("user-not-found") || code.includes("wrong-password") || code.includes("invalid-credential")) {
        setErr("Incorrect email or password.");
      } else if (code.includes("too-many-requests")) {
        setErr("Too many attempts. Please try again later.");
      } else {
        setErr(e.message || "Login failed.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="portal-bg">
      <div className="login-card">
        <div className="login-logo">
          <span className="lobby-pulse" style={{ width: 10, height: 10 }} />
          {CLINIC_NAME}
        </div>
        <h2 className="login-title">Staff Sign in</h2>

        <div className="field-group">
          <label className="field-label">Email</label>
          <input className="field-input" type="email" value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email" placeholder="your@email.com" />
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
            if (r?.redirecting) return;
            if (!r?.success) setErr(r?.error || "Access denied. Your account is not authorised as staff.");
          } catch (e) { setErr(e.message); }
          finally { setLoading(false); }
        }} disabled={loading}>
          <svg width="18" height="18" viewBox="0 0 18 18" style={{ marginRight: "8px" }}>
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/>
          </svg>
          {loading ? "Signing in…" : "Sign in with Google"}
        </button>
        <div className="dim" style={{ fontSize: "0.75rem", textAlign: "center", marginTop: "0.5rem" }}>
          Forgot your password? Ask Admin to send a reset email.
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   ADMIN LOGIN — Developer + Admin (Google only)
   URL: /login (same as staff)
───────────────────────────────────────────── */

/* ─────────────────────────────────────────────
   DOCTOR PORTAL
───────────────────────────────────────────── */
function DoctorPortal({ room: roomProp }) {
  const { state, setRoom: setRoomState, ready } = useClinicState();
  const { user } = useAuth();

  // ALL hooks must be declared before any early returns
  const [patients, setPatients] = useState([]);
  const [docTheme, setDocTheme] = useState(() => localStorage.getItem("cq_doctor_theme") || "light");
  const [breakInput, setBreakInput] = useState("");
  const [showBreakInput, setShowBreakInput] = useState(false);
  const [customCallInput, setCustomCallInput] = useState("");
  const [showCustomCall, setShowCustomCall] = useState(false);
  const [manualTokenInput, setManualTokenInput] = useState("");
  const [showManualToken, setShowManualToken] = useState(false);
  const play = useChime(state.chime);
  const today = new Date().toISOString().slice(0, 10);

  const toggleDocTheme = () => {
    const next = docTheme === "dark" ? "light" : "dark";
    setDocTheme(next);
    localStorage.setItem("cq_doctor_theme", next);
  };

  // Find which room this doctor is assigned to
  const room = (() => {
    if (roomProp) return roomProp;
    if (!user || !ready) return null;

    const allDoctors = Object.values(state.doctorDirectory || {});
    const allAssigned = Object.entries(state.assigned || {});

    // 1. Match by email in doctorDirectory
    if (user.email) {
      const byEmail = allDoctors.find((d) => d.email && d.email.toLowerCase() === user.email.toLowerCase());
      if (byEmail) {
        const r = allAssigned.find(([, a]) => a?.id === byEmail.id);
        if (r) return r[0];
        return "__notassigned__";
      }
    }

    // 2. Match by display name
    const displayName = user.displayName || "";
    if (displayName) {
      const byName = allDoctors.find((d) => d.name && d.name.toLowerCase() === displayName.toLowerCase());
      if (byName) {
        const r = allAssigned.find(([, a]) => a?.id === byName.id);
        if (r) return r[0];
        return "__notassigned__";
      }
    }

    // 3. Match by email in room assignment
    if (user.email) {
      const byAssigned = allAssigned.find(([, a]) => a?.email && a.email.toLowerCase() === user.email.toLowerCase());
      if (byAssigned) return byAssigned[0];
    }

    // 4. Match by UID in room assignment
    const byUid = allAssigned.find(([, a]) => a?.uid && a.uid === user.uid);
    if (byUid) return byUid[0];

    // 5. Email prefix vs doctor name (last resort)
    const emailPrefix = (user.email || "").split("@")[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
    if (emailPrefix.length > 3) {
      const byPrefix = allDoctors.find((d) => d.name && d.name.toLowerCase().replace(/[^a-z]/g, "").includes(emailPrefix));
      if (byPrefix) {
        const r = allAssigned.find(([, a]) => a?.id === byPrefix.id);
        if (r) return r[0];
        return "__notassigned__";
      }
    }

    return null;
  })();

  const actualRoom = (room && room !== "__notassigned__") ? room : null;
  const assigned = actualRoom ? state.assigned[actualRoom] : null;
  const nowServing = actualRoom ? (state.customCall[actualRoom] ?? state.nowServing[actualRoom]) : null;
  const upNext = actualRoom ? state.upNext[actualRoom] : null;
  const status = actualRoom ? (state.status[actualRoom] || "IDLE") : "IDLE";
  const session = actualRoom ? state.sessions[actualRoom] : null;

  // Find this doctor's directory entry for queries
  const doctorEntry = user?.email
    ? Object.values(state.doctorDirectory || {}).find(
        (d) => d.email && d.email.toLowerCase() === user.email.toLowerCase()
      )
    : null;
  const myDoctorId = doctorEntry?.id || assigned?.id || null;

  // Load today's patient list — query by doctorId OR doctorName to handle ID mismatches
  useEffect(() => {
    const docName = doctorEntry?.name || assigned?.name || null;
    if (!myDoctorId && !docName) return;

    // Try by doctorId first, fall back to doctorName
    const q = myDoctorId
      ? query(VISITS_COL, where("doctorId", "==", myDoctorId), where("date", "==", today))
      : query(VISITS_COL, where("doctorName", "==", docName), where("date", "==", today));

    const unsub = onSnapshot(q, async (snap) => {
      let list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      // If doctorId query returned nothing, try by name
      if (list.length === 0 && myDoctorId && docName) {
        try {
          const q2 = query(VISITS_COL, where("doctorName", "==", docName), where("date", "==", today));
          const snap2 = await getDocs(q2);
          list = snap2.docs.map((d) => ({ id: d.id, ...d.data() }));
        } catch {}
      }
      list.sort((a, b) => (a.token || 0) - (b.token || 0));
      setPatients(list);
    });
    return unsub;
  }, [myDoctorId, today]);

  if (!ready) {
    return (
      <div className="portal-bg">
        <div className="portal-container">
          <div className="card" style={{ textAlign: "center", padding: "3rem" }}>
            <div className="spinner" style={{ margin: "0 auto 1rem" }} />
            <div className="dim">Connecting…</div>
          </div>
        </div>
      </div>
    );
  }

  if (!actualRoom) {
    const matchedByEmail = Object.values(state.doctorDirectory || {}).find(
      (d) => d.email?.toLowerCase() === user?.email?.toLowerCase()
    );
    return (
      <div className="portal-bg">
        <div className="portal-container">
          <div className="portal-header">
            <div>
              <h1 className="portal-title">Doctor Portal</h1>
              <div className="portal-sub">{user?.email}</div>
            </div>
          </div>
          <div className="card" style={{ textAlign: "center", padding: "3rem" }}>
            <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>🏥</div>
            {room === "__notassigned__" ? (
              <>
                <div style={{ fontWeight: 600, fontSize: "1.1rem", marginBottom: "0.5rem" }}>
                  No room assigned yet
                </div>
                <div className="dim" style={{ fontSize: "0.85rem" }}>
                  Please ask Reception to assign you to a room for today.
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600, fontSize: "1.1rem", marginBottom: "0.5rem" }}>
                  Account not linked
                </div>
                <div className="dim" style={{ fontSize: "0.85rem", marginBottom: "1.5rem" }}>
                  Your account isn't linked to the doctor directory yet. Ask the Developer to rebuild the doctor directory from the Staff tab.
                </div>
                <div style={{ background: "var(--bg)", borderRadius: "8px", padding: "0.75rem", fontSize: "0.75rem", textAlign: "left", maxWidth: "320px", margin: "0 auto" }}>
                  <div className="dim" style={{ marginBottom: "0.3rem" }}>Debug info for Developer:</div>
                  <div className="mono" style={{ fontSize: "0.7rem" }}>Email: {user?.email || "(blank)"}</div>
                  <div className="mono" style={{ fontSize: "0.7rem" }}>UID: {user?.uid?.slice(0, 16)}…</div>
                  <div className="mono" style={{ fontSize: "0.7rem" }}>In directory: {matchedByEmail ? "Yes — " + matchedByEmail.name : "No"}</div>
                  <div className="mono" style={{ fontSize: "0.7rem" }}>Assigned rooms: {Object.entries(state.assigned || {}).filter(([,a]) => a).map(([r,a]) => `${r}:${a?.name}`).join(", ") || "none"}</div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Write only this room's document, then chime
  const act = async (patch, auditAction, chimeType = "CALL") => {
    if (!actualRoom) return;
    await setRoomState(actualRoom, patch, { role: "DOCTOR", action: auditAction, room: actualRoom, ts: Date.now() });
    play(chimeType, { force: true });
  };

  const startSession = async () => {
    // Find the first waiting token for today to start from
    let tokenStart = 1;
    const docName = doctorEntry?.name || assigned?.name;
    if (myDoctorId || docName) {
      try {
        const queries = [];
        if (myDoctorId) queries.push(getDocs(query(VISITS_COL, where("doctorId", "==", myDoctorId), where("date", "==", today), where("status", "==", "waiting"))));
        if (docName) queries.push(getDocs(query(VISITS_COL, where("doctorName", "==", docName), where("date", "==", today), where("status", "==", "waiting"))));
        const snaps = await Promise.all(queries);
        const tokens = [];
        const seen = new Set();
        snaps.forEach((snap) => snap.docs.forEach((d) => {
          if (!seen.has(d.id)) { seen.add(d.id); const t = d.data().token; if (t) tokens.push(t); }
        }));
        if (tokens.length > 0) tokenStart = Math.min(...tokens);
      } catch {}
    }
    act({
      sessions: { startedAt: Date.now(), tokenStart, served: 0 },
      nowServing: tokenStart,
      upNext: tokenStart + 1,
      customCall: null,
      status: "SESSION STARTED",
    }, "startSession", "CALL");
  };

  const endSession = async () => {
    const sess = state.sessions[actualRoom];
    const endedAt = Date.now();
    const today = new Date().toISOString().slice(0, 10);
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
    // Clear all remaining waiting appointments for this room today
    try {
      const q = query(VISITS_COL, where("room", "==", actualRoom), where("date", "==", today), where("status", "==", "waiting"));
      const snap = await getDocs(q);
      await Promise.all(snap.docs.map((d) => setDoc(doc(db, "clinicq_visits", d.id), { status: "cleared" }, { merge: true })));
    } catch (e) { console.warn("Clear appointments failed:", e.message); }
    act({
      sessions: null,
      nowServing: null,
      upNext: null,
      customCall: null,
      status: "SESSION ENDED",
    }, "endSession", "END");
  };

  const markServed = async (visitId) => {
    try {
      await setDoc(doc(db, "clinicq_visits", visitId), { status: "served" }, { merge: true });
    } catch (e) { console.warn("markServed:", e.message); }
  };

  const markMissed = async (visitId) => {
    try {
      await setDoc(doc(db, "clinicq_visits", visitId), { status: "missed" }, { merge: true });
    } catch (e) { console.warn("markMissed:", e.message); }
  };

  // Recall a missed patient — calls their token via customCall without disrupting the queue,
  // and reverts them to "waiting" so they can be processed normally when they respond.
  const recallPatient = async (visit) => {
    try {
      await setDoc(doc(db, "clinicq_visits", visit.id), { status: "waiting" }, { merge: true });
    } catch (e) { console.warn("recallPatient:", e.message); }
    act({ customCall: String(visit.token), status: "CALLING" }, "recallMissed", "CALL");
  };

  const nextToken = () => {
    const cur = state.nowServing[actualRoom] || 0;
    const next = cur + 1;
    const sess = state.sessions[actualRoom];
    act({
      nowServing: next,
      upNext: next + 1,
      customCall: null,
      status: "CALLING",
      sessions: sess ? { ...sess, served: (sess.served || 0) + 1 } : null,
    }, "next", "CALL");
    // Mark the patient who was just served (token === cur) as served
    if (cur > 0) {
      const visit = patients.find((p) => p.token === cur && p.status === "waiting");
      if (visit) markServed(visit.id);
    }
  };

  // Mark the current patient (at nowServing) as missed, then advance to next
  const noShow = () => {
    const cur = state.nowServing[actualRoom] || 0;
    if (cur > 0) {
      const visit = patients.find((p) => p.token === cur && p.status === "waiting");
      if (visit) markMissed(visit.id);
    }
    const next = cur + 1;
    act({
      nowServing: next,
      upNext: next + 1,
      customCall: null,
      status: "CALLING",
    }, "noShow", "CALL");
  };

  const prevToken = () => {
    const cur = Math.max(1, (state.nowServing[actualRoom] || 1) - 1);
    act({
      nowServing: cur,
      upNext: cur + 1,
      customCall: null,
      status: "CALLING",
    }, "previous", "CALL");
  };

  const confirmPause = () => {
    let returnTime = null;
    if (breakInput.trim()) {
      const mins = parseInt(breakInput);
      if (!isNaN(mins) && mins > 0) {
        const ret = new Date(Date.now() + mins * 60000);
        returnTime = ret.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } else if (breakInput.includes(":")) {
        returnTime = breakInput.trim();
      }
    }
    const patch = { status: "PAUSED" };
    if (returnTime) patch.sessions = { ...(session || {}), returnTime };
    act(patch, "pause", "CALL");
    setShowBreakInput(false); setBreakInput("");
  };

  const pauseResume = () => {
    if (status === "PAUSED") {
      const patch = { status: "CALLING" };
      if (session?.returnTime) patch.sessions = { ...session, returnTime: null };
      act(patch, "resume", "CALL");
      setShowBreakInput(false); setBreakInput("");
    } else {
      setShowBreakInput(true);
      setShowCustomCall(false); setShowManualToken(false);
    }
  };

  const recall = () => {
    act({ status: "RECALL" }, "recall", "RECALL");
  };

  const confirmCustomCall = () => {
    if (!customCallInput.trim()) return;
    act({ customCall: customCallInput.trim(), status: "CALLING" }, "customCall", "CALL");
    setShowCustomCall(false); setCustomCallInput("");
  };

  const customCall = () => {
    setShowCustomCall((v) => !v);
    setShowBreakInput(false); setShowManualToken(false);
  };

  const confirmManualToken = () => {
    const n = parseInt(manualTokenInput, 10);
    if (isNaN(n) || n < 1) return;
    act({ nowServing: n, upNext: n + 1, customCall: null, status: "CALLING" }, "manualToken", "CALL");
    setShowManualToken(false); setManualTokenInput("");
  };

  const manualToken = () => {
    setShowManualToken((v) => !v);
    setShowBreakInput(false); setShowCustomCall(false);
  };

  const sessionDur = session?.startedAt
    ? Math.round((Date.now() - session.startedAt) / 60000)
    : 0;

  return (
    <div className={`portal-bg${docTheme === "dark" ? " doctor-dark-theme" : ""}`}>
      {docTheme === "dark" && (
        <style>{`
          .doctor-dark-theme {
            --bg: #0a0e17;
            --surface: #131a28;
            --text: #e8eaf0;
            --text-dim: #8b96ab;
            --border: #232c3f;
            --shadow: 0 1px 3px rgba(0,0,0,0.4);
          }
          .doctor-dark-theme .btn-outline { border-color: var(--border); color: var(--text); }
          .doctor-dark-theme .field-input { background: var(--surface); color: var(--text); border-color: var(--border); }
          .doctor-dark-theme .data-table th { color: var(--text-dim); border-color: var(--border); }
          .doctor-dark-theme .data-table td { border-color: var(--border); }
        `}</style>
      )}
      <div className="portal-container">
        <div className="portal-header">
          <div>
            <h1 className="portal-title">Doctor Portal</h1>
            <div className="portal-sub">{actualRoom ? roomDisplay(actualRoom) : ""}{assigned ? ` · ${assigned.name}` : " · Unassigned"}</div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <div className="status-pill" style={{ background: statusColor(status) + "22", color: statusColor(status) }}>
              {status}
            </div>
            <button className="btn btn-outline btn-sm" onClick={toggleDocTheme} title="Toggle theme">
              {docTheme === "light" ? "🌙 Dark" : "☀️ Light"}
            </button>
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
            <button className="btn btn-outline" onClick={noShow} style={{ color: "#f97316", borderColor: "#f9731644" }}>⊘ No Show</button>
          </div>

          <div className="action-section-title">Advanced</div>
          <div className="action-row">
            <button className="btn btn-outline" onClick={pauseResume}>
              {status === "PAUSED" ? "▶ Resume" : "⏸ Pause"}
            </button>
            <button className={`btn btn-outline${showCustomCall ? " active" : ""}`} onClick={customCall}>✎ Custom Call</button>
            <button className={`btn btn-outline${showManualToken ? " active" : ""}`} onClick={manualToken}>⌨ Set Token</button>
          </div>

          {/* Inline: Break duration input */}
          {showBreakInput && (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem", padding: "0.75rem", background: "var(--bg)", borderRadius: "8px", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", whiteSpace: "nowrap" }}>Break duration:</div>
              <input className="field-input" style={{ flex: 1, padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
                placeholder="mins (e.g. 15) or time (e.g. 14:30) — leave blank for indefinite"
                value={breakInput} onChange={(e) => setBreakInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirmPause()}
                autoFocus />
              <button className="btn btn-yellow btn-sm" onClick={confirmPause}>⏸ Pause</button>
              <button className="btn btn-outline btn-sm" onClick={() => { setShowBreakInput(false); setBreakInput(""); }}>Cancel</button>
            </div>
          )}

          {/* Inline: Custom call input */}
          {showCustomCall && (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem", padding: "0.75rem", background: "var(--bg)", borderRadius: "8px", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", whiteSpace: "nowrap" }}>Call token:</div>
              <input className="field-input" style={{ flex: 1, padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
                placeholder="Token number or label"
                value={customCallInput} onChange={(e) => setCustomCallInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirmCustomCall()}
                autoFocus />
              <button className="btn btn-blue btn-sm" onClick={confirmCustomCall}>Call</button>
              <button className="btn btn-outline btn-sm" onClick={() => { setShowCustomCall(false); setCustomCallInput(""); }}>Cancel</button>
            </div>
          )}

          {/* Inline: Set token input */}
          {showManualToken && (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem", padding: "0.75rem", background: "var(--bg)", borderRadius: "8px", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", whiteSpace: "nowrap" }}>Set now serving to:</div>
              <input className="field-input" style={{ width: "80px", padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
                type="number" min="1" placeholder="No."
                value={manualTokenInput} onChange={(e) => setManualTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirmManualToken()}
                autoFocus />
              <button className="btn btn-blue btn-sm" onClick={confirmManualToken}>Set</button>
              <button className="btn btn-outline btn-sm" onClick={() => { setShowManualToken(false); setManualTokenInput(""); }}>Cancel</button>
            </div>
          )}
        </div>

        {/* Today's patient list */}
        <div className="card" style={{ marginTop: "1rem" }}>
          <h2 className="card-title">Today's Patients ({patients.filter(p => p.status !== "cancelled" && p.status !== "cleared").length})</h2>

          {/* Now Serving card */}
          {nowServing != null && (() => {
            const current = patients.find((p) => p.token === nowServing);
            return (
              <div style={{ background: "#22c55e12", border: "1px solid #22c55e33", borderRadius: "12px", padding: "1rem 1.25rem", marginBottom: "1rem", display: "flex", alignItems: "center", gap: "1.25rem", flexWrap: "wrap" }}>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "3rem", fontWeight: 800, color: "#22c55e", lineHeight: 1, minWidth: "60px", textAlign: "center" }}>{nowServing}</div>
                <div style={{ flex: 1, minWidth: "160px" }}>
                  <div style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", color: "#22c55e", marginBottom: "0.2rem" }}>NOW SERVING</div>
                  <div style={{ fontWeight: 600, fontSize: "1.05rem" }}>{current?.name || "—"}</div>
                  <div className="dim" style={{ fontSize: "0.8rem" }}>
                    {current?.patientId || ""}
                    {current?.policeServiceNo ? ` · Svc No: ${current.policeServiceNo}` : ""}
                  </div>
                  {current && (
                    <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
                      {current.patientCategory && current.patientCategory !== "General" && (
                        <span className="status-pill" style={{ background: "#a855f722", color: "#a855f7", fontSize: "0.7rem" }}>
                          {current.patientCategory}
                        </span>
                      )}
                      {current.consultationType === "Online" && (
                        <span className="status-pill" style={{ background: "#0ea5e922", color: "#0ea5e9", fontSize: "0.7rem" }}>
                          Online
                        </span>
                      )}
                      {current.isFollowUp && (
                        <span className="status-pill" style={{ background: "#eab30822", color: "#eab308", fontSize: "0.7rem" }}>
                          Follow-up
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {patients.length === 0 ? (
            <div className="dim">No appointments booked yet today.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>#</th><th>Patient</th><th>ID</th><th>Tags</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {patients.map((p) => {
                    const isCurrent = p.token === nowServing;
                    const isNext = p.token === upNext;
                    const isServed = p.status === "served";
                    const isMissed = p.status === "missed";
                    const isCancelled = p.status === "cancelled" || p.status === "cleared";
                    const isDimmed = isServed || isCancelled;
                    return (
                      <tr key={p.id} style={{
                        background: isCurrent ? "#22c55e12" : isNext ? "#3b82f612" : isMissed ? "#f9731612" : "transparent",
                        opacity: isDimmed ? 0.4 : 1,
                      }}>
                        <td>
                          <span style={{ fontWeight: 700, fontSize: "1rem", color: isCurrent ? "#22c55e" : isNext ? "#3b82f6" : isMissed ? "#f97316" : "inherit" }}>
                            {p.token ?? "—"}
                            {isCurrent && " ●"}
                          </span>
                        </td>
                        <td style={{ fontWeight: isCurrent ? 600 : 400 }}>{p.name}</td>
                        <td className="mono" style={{ fontSize: "0.8rem" }}>
                          <div>{p.patientId || "—"}</div>
                          {p.policeServiceNo && <div className="dim" style={{ fontSize: "0.72rem" }}>Svc: {p.policeServiceNo}</div>}
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                            {p.patientCategory && p.patientCategory !== "General" && (
                              <span className="status-pill" style={{ background: "#a855f722", color: "#a855f7", fontSize: "0.68rem" }}>
                                {p.patientCategory}
                              </span>
                            )}
                            {p.consultationType === "Online" && (
                              <span className="status-pill" style={{ background: "#0ea5e922", color: "#0ea5e9", fontSize: "0.68rem" }}>
                                Online
                              </span>
                            )}
                            {p.isFollowUp && (
                              <span className="status-pill" style={{ background: "#eab30822", color: "#eab308", fontSize: "0.68rem" }}>
                                Follow-up
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="status-pill" style={{
                            background: isServed ? "#64748b22" : isCancelled ? "#ef444422" : isMissed ? "#f9731622" : isCurrent ? "#22c55e22" : isNext ? "#3b82f622" : "#64748b11",
                            color: isServed ? "#64748b" : isCancelled ? "#ef4444" : isMissed ? "#f97316" : isCurrent ? "#22c55e" : isNext ? "#3b82f6" : "var(--text-dim)",
                          }}>
                            {isServed ? "✓ Served" : isCancelled ? "Cancelled" : isMissed ? "Missed" : isCurrent ? "Now" : isNext ? "Next" : "Waiting"}
                          </span>
                        </td>
                        <td>
                          {isMissed ? (
                            <button className="btn btn-outline btn-sm" onClick={() => recallPatient(p)}>↻ Call again</button>
                          ) : !isServed && !isCancelled && (
                            <button className="btn btn-outline btn-sm" onClick={() => markServed(p.id)}>✓ Done</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   ADMIN PORTAL
───────────────────────────────────────────── */
// AdminPortal — merged Admin + SuperAdmin
// Injected into App.jsx by build script

function AdminPortal() {
  const { state, setState, setRoom, ready } = useClinicState();
  const [tab, setTab] = useState("rooms");
  const [newRoom, setNewRoom] = useState("");
  const [auditLog, setAuditLog] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const TABS = ["rooms", "staff", "stafflogins", "analytics", "audit", "settings"];
  const TAB_LABELS = { rooms: "🏥 Rooms", staff: "👥 Staff Directory", stafflogins: "📧 Login Emails", analytics: "📊 Analytics", audit: "📋 Audit", settings: "⚙️ Settings" };

  const activeDoctors = Object.values(state.doctorDirectory || {}).filter((d) => d.active);

  const assign = async (roomId, doctorId) => {
    const d = doctorId ? state.doctorDirectory[doctorId] : null;
    await setRoom(roomId, {
      assigned: d ? { id: d.id, name: d.name, department: d.specialty || "General", email: d.email || "" } : null,
      status: "IDLE", sessions: null, nowServing: null, upNext: null, customCall: null,
    }, { role: "ADMIN", action: "assignDoctor", roomId, doctorId });
  };

  const endSession = async (roomId) => {
    if (!window.confirm(`End session for ${roomId}?`)) return;
    await setRoom(roomId, {
      assigned: null, sessions: null, nowServing: null, upNext: null, customCall: null, status: "SESSION ENDED",
    }, { role: "ADMIN", action: "endSession", roomId });
  };

  const addRoom = async () => {
    const id = newRoom.trim().toUpperCase();
    if (!id || (state.rooms || []).includes(id)) return;
    const rooms = [...(state.rooms || DEFAULT_ROOMS), id];
    await setState({ ...state, rooms }, { role: "ADMIN", action: "addRoom", id });
    setNewRoom("");
  };

  const removeRoom = async (id) => {
    if (!window.confirm(`Remove room ${id}? This cannot be undone.`)) return;
    const rooms = (state.rooms || []).filter((r) => r !== id);
    await setState({ ...state, rooms }, { role: "ADMIN", action: "removeRoom", id });
    await deleteRoomDoc(id);
  };

  const loadAudit = async () => {
    setAuditLoading(true);
    try {
      const q = query(AUDIT_COL, orderBy("ts", "desc"), limit(50));
      const snap = await getDocs(q);
      setAuditLog(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      setAuditLog([{ id: "err", action: "Failed: " + e.message }]);
    }
    setAuditLoading(false);
  };
  useEffect(() => { if (tab === "audit") loadAudit(); }, [tab]);

  return (
    <div className="portal-bg">
      <div className="portal-container">
        <div className="portal-header">
          <div>
            <h1 className="portal-title">Admin Portal</h1>
            <div className="portal-sub">Clinic management</div>
          </div>
        </div>
        <div className="tab-bar">
          {TABS.map((t) => (
            <button key={t} className={`tab-btn${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {tab === "rooms" && (
          <div className="card">
            <h2 className="card-title">Room Management</h2>
            <div className="add-row">
              <input className="field-input" placeholder="Room ID (e.g. R06)" value={newRoom} onChange={(e) => setNewRoom(e.target.value)} />
              <button className="btn btn-green" onClick={addRoom}>+ Add Room</button>
            </div>
            <div className="divide-list" style={{ marginBottom: "1.5rem" }}>
              {(state.rooms || DEFAULT_ROOMS).map((r) => (
                <div key={r} className="divide-row">
                  <div>
                    <div className="fw-med mono">{r}</div>
                    <div className="dim" style={{ fontSize: "0.82rem" }}>{state.assigned[r]?.name || "Unassigned"} · {state.status[r]}</div>
                  </div>
                  <div className="btn-group">
                    <select className="field-input" style={{ width: "auto", fontSize: "0.85rem" }}
                      value={state.assigned[r]?.id || ""}
                      onChange={(e) => assign(r, e.target.value || null)}>
                      <option value="">— Unassigned —</option>
                      {activeDoctors.map((d) => (
                        <option key={d.id} value={d.id}>{d.name} ({d.specialty || "General"})</option>
                      ))}
                    </select>
                    <button className="btn btn-red btn-sm" onClick={() => endSession(r)}>End Session</button>
                    <button className="btn btn-outline btn-sm" onClick={() => removeRoom(r)}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
            <h2 className="card-title">Room Status</h2>
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

        {tab === "staff" && <StaffDirectoryTab state={state} setState={setState} />}
        {tab === "stafflogins" && <StaffLoginsTab />}
        {tab === "analytics" && <AnalyticsTab />}
        {tab === "settings" && <AdminSettingsTab state={state} setState={setState} />}

        {tab === "audit" && (
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h2 className="card-title" style={{ margin: 0 }}>Audit Log (last 50)</h2>
              <button className="btn btn-outline btn-sm" onClick={loadAudit}>Refresh</button>
            </div>
            {auditLoading && <div className="dim">Loading...</div>}
            {!auditLoading && auditLog.length === 0 && <div className="dim">No entries yet.</div>}
            {!auditLoading && auditLog.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Time</th><th>Role</th><th>Action</th><th>Room</th></tr></thead>
                  <tbody>
                    {auditLog.map((e) => (
                      <tr key={e.id}>
                        <td className="dim mono" style={{ fontSize: "0.75rem" }}>{e.ts?.toDate ? e.ts.toDate().toLocaleTimeString() : "—"}</td>
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
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   STAFF LOGINS TAB — Admin sends password resets
───────────────────────────────────────────── */
function StaffLoginsTab() {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState({});
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    getDoc(STAFF_DOC).then((snap) => {
      const people = snap.exists() ? (snap.data().people || []) : [];
      // Only doctors and receptionists
      setStaff(people.filter((p) => p.email));  // Show all staff with an email address
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const sendReset = async (person) => {
    if (!person.email) { setMsg((m) => ({ ...m, [person.email]: "No email on file." })); return; }
    setBusy(person.email);
    try {
      const { sendPasswordResetEmail } = await import("firebase/auth");
      const { auth } = await import("./firebase.js");
      await sendPasswordResetEmail(auth, person.email, {
        url: `${APP_URL}/login`,
        handleCodeInApp: false,
      });
      setMsg((m) => ({ ...m, [person.email]: "✓ Reset email sent to " + person.email }));
    } catch (e) {
      setMsg((m) => ({ ...m, [person.email]: "Failed: " + e.message }));
    } finally { setBusy(null); }
  };

  if (loading) return <div className="card dim">Loading…</div>;

  return (
    <div className="card">
      <h2 className="card-title">Staff Logins</h2>
      <p className="dim" style={{ fontSize: "0.83rem", marginBottom: "1.25rem" }}>
        Send a password reset email to any doctor or receptionist. They'll receive a link to set a new password.
      </p>
      {staff.length === 0 ? (
        <div className="dim">No staff with logins yet. Assign roles in the Developer portal.</div>
      ) : (
        <div className="divide-list">
          {staff.map((p) => (
            <div key={p.email || p.name} className="divide-row">
              <div>
                <div className="fw-med">{p.name}</div>
                <div className="dim" style={{ fontSize: "0.82rem" }}>
                  {p.role} · {p.email || "No email"}
                </div>
                {msg[p.email] && (
                  <div style={{ fontSize: "0.78rem", marginTop: "0.2rem", color: msg[p.email].startsWith("✓") ? "var(--green)" : "var(--red)" }}>
                    {msg[p.email]}
                  </div>
                )}
              </div>
              <button className="btn btn-outline btn-sm" disabled={busy === p.email || !p.email}
                onClick={() => sendReset(p)}>
                {busy === p.email ? "Sending…" : "Send reset email"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   ADMIN SETTINGS TAB — Branding, Schedule, Chime, Theme
───────────────────────────────────────────── */
function AdminSettingsTab({ state, setState }) {
  const [section, setSection] = useState("branding");
  const updateChime = async (patch) => {
    await setState({ ...state, chime: { ...state.chime, ...patch } }, { role: "ADMIN", action: "chimeUpdate" });
  };
  const testChime = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const vol = ctx.createGain(); vol.gain.value = state.chime?.volume ?? 0.22; vol.connect(ctx.destination);
      const beep = (t, f) => { const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; o.connect(vol); o.start(t); o.stop(t + 0.14); };
      const t0 = ctx.currentTime + 0.01; beep(t0, 880); beep(t0 + 0.22, 1046);
    } catch {}
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {[["branding", "🎨 Branding"], ["schedule", "🕐 Schedule"], ["chime", "🔔 Chime"], ["theme", "🌓 Lobby Theme"]].map(([k, label]) => (
          <button key={k} className={`tab-btn${section === k ? " active" : ""}`} onClick={() => setSection(k)}>{label}</button>
        ))}
      </div>

      {section === "branding" && <BrandingTab />}
      {section === "schedule" && <ScheduleTab state={state} setState={setState} />}

      {section === "chime" && (
        <div className="card">
          <h2 className="card-title">Chime Settings</h2>
          <div className="chime-grid">
            <label className="toggle-row"><span>Enabled</span><input type="checkbox" checked={!!state.chime?.enabled} onChange={(e) => updateChime({ enabled: e.target.checked })} /></label>
            <label className="toggle-row"><span>Do Not Disturb</span><input type="checkbox" checked={!!state.chime?.doNotDisturb} onChange={(e) => updateChime({ doNotDisturb: e.target.checked })} /></label>
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

      {section === "theme" && (
        <div className="card">
          <h2 className="card-title">Lobby Theme</h2>
          <p className="dim" style={{ fontSize: "0.83rem", marginBottom: "1.25rem" }}>
            Controls the lobby TV display. Dark is better for dedicated screens; light works in bright rooms.
          </p>
          <div style={{ display: "flex", gap: "1rem" }}>
            {[["dark", "🌙 Dark", "Best for TV displays"], ["light", "☀️ Light", "Better for bright rooms"]].map(([val, label, desc]) => (
              <div key={val}
                onClick={() => setState({ ...state, lobbyTheme: val }, { role: "ADMIN", action: "setLobbyTheme", val })}
                style={{
                  flex: 1, padding: "1.25rem", border: `2px solid ${state.lobbyTheme === val ? "var(--blue)" : "var(--border)"}`,
                  borderRadius: "12px", cursor: "pointer", background: state.lobbyTheme === val ? "#2563eb11" : "var(--surface)",
                  transition: "all 0.15s",
                }}>
                <div style={{ fontSize: "1.5rem", marginBottom: "0.4rem" }}>{label.split(" ")[0]}</div>
                <div style={{ fontWeight: 600 }}>{label.split(" ")[1]}</div>
                <div className="dim" style={{ fontSize: "0.8rem" }}>{desc}</div>
                {state.lobbyTheme === val && <div style={{ fontSize: "0.75rem", color: "var(--blue)", marginTop: "0.5rem", fontWeight: 600 }}>● Active</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   DEVELOPER PORTAL
───────────────────────────────────────────── */
function DeveloperPortal() {
  const { state, setState } = useClinicState();
  const [tab, setTab] = useState("rooms");
  const [newRoom, setNewRoom] = useState("");

  const addRoom = async () => {
    const id = newRoom.trim().toUpperCase();
    if (!id || (state.rooms || []).includes(id)) return;
    const rooms = [...(state.rooms || DEFAULT_ROOMS), id];
    await setState({ ...state, rooms }, { role: "DEVELOPER", action: "addRoom", id });
    setNewRoom("");
  };

  const removeRoom = async (id) => {
    if (!window.confirm(`Remove room ${id}? This cannot be undone.`)) return;
    const rooms = (state.rooms || []).filter((r) => r !== id);
    await setState({ ...state, rooms }, { role: "DEVELOPER", action: "removeRoom", id });
    await deleteRoomDoc(id);
  };

  const updateChime = async (patch) => {
    await setState({ ...state, chime: { ...state.chime, ...patch } }, { role: "DEVELOPER", action: "chimeUpdate" });
  };

  const testChime = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const vol = ctx.createGain(); vol.gain.value = state.chime?.volume ?? 0.22; vol.connect(ctx.destination);
      const beep = (t, f) => { const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; o.connect(vol); o.start(t); o.stop(t + 0.14); };
      const t0 = ctx.currentTime + 0.01; beep(t0, 880); beep(t0 + 0.22, 1046);
    } catch {}
  };

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
          {["rooms","import","staff","patients","admins","chime","branding","schedule","analytics"].map((t) => (
            <button key={t} className={`tab-btn${tab===t?" active":""}`} onClick={() => setTab(t)}>
              {t==="rooms"?"🏥 Rooms":t==="import"?"📥 Import":t==="staff"?"👥 Staff Directory":t==="patients"?"🏥 Patients":t==="admins"?"🔐 Admins":t==="chime"?"🔔 Chime":t==="branding"?"🎨 Branding":t==="schedule"?"🕐 Schedule":"📊 Analytics"}
            </button>
          ))}
        </div>

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
        {tab === "import" && <StaffImportTab state={state} setState={setState} />}
        {tab === "staff" && <StaffDirectoryTab state={state} setState={setState} />}
        {tab === "patients" && <PatientImportTab />}
        {tab === "admins" && <AdminEmailsTab state={state} setState={setState} />}
        {tab === "schedule" && <ScheduleTab state={state} setState={setState} />}
        {tab === "analytics" && <AnalyticsTab />}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   SHARED: load + role helpers for staff
───────────────────────────────────────────── */
// Build a stable doctorDirectory from the staff list
// Uses email as the stable key so it never drifts from the login system
async function rebuildDoctorDirectory(people, state, setState, setStaff) {
  const dir = {};
  let staffList = [...people];
  let staffChanged = false;

  // Build directory from staff with category === "doctor" and active !== false
  // Login status (role) no longer affects whether they appear in operational dropdowns
  staffList.filter((p) => p.category === "doctor" && p.active !== false && p.name).forEach((p) => {
    const key = p.email
      ? "doc_" + p.email.replace(/[^a-zA-Z0-9]/g, "_")
      : "doc_" + p.name.replace(/[^a-zA-Z0-9]/g, "_");
    dir[key] = {
      id: key,
      name: p.name,
      specialty: p.designation || "General",
      idNumber: p.idNumber || "",
      registrationNo: p.registrationNo || "",
      email: p.email || "",
      active: true,
    };
  });

  // Migrate: any existing doctorDirectory entries not represented in staff get added to staff
  // (covers doctors added before the staff directory existed, e.g. via old "Add Doctor" UI)
  const existing = state.doctorDirectory || {};
  Object.values(existing).forEach((d) => {
    const inStaff = staffList.find((p) =>
      (d.email && p.email && p.email.toLowerCase() === d.email.toLowerCase()) ||
      (!d.email && p.name === d.name)
    );
    if (!inStaff && d.name) {
      // Add to staff as a doctor
      staffList.push({
        name: d.name,
        idNumber: d.idNumber || "",
        registrationNo: d.registrationNo || "",
        designation: d.specialty || "General",
        email: d.email || "",
        contact: "",
        category: "doctor",
        active: d.active !== false, // carry over legacy active flag
        role: d.email ? "DOCTOR" : null, // assume they have a login if they have an email
      });
      staffChanged = true;
      if (d.active !== false) {
        const key = d.email
          ? "doc_" + d.email.replace(/[^a-zA-Z0-9]/g, "_")
          : "doc_" + d.name.replace(/[^a-zA-Z0-9]/g, "_");
        if (!dir[key]) dir[key] = { ...d, id: key, active: true };
      }
    } else if (inStaff && d.active === false && inStaff.active !== false) {
      // Legacy inactive flag on the old directory entry wasn't reflected in staff — sync it
      const idx = staffList.findIndex((p) => p === inStaff);
      if (idx >= 0) {
        staffList[idx] = { ...staffList[idx], active: false };
        staffChanged = true;
        // Remove from the freshly-built dir if it got included
        const key = inStaff.email
          ? "doc_" + inStaff.email.replace(/[^a-zA-Z0-9]/g, "_")
          : "doc_" + inStaff.name.replace(/[^a-zA-Z0-9]/g, "_");
        delete dir[key];
      }
    }
  });

  await setState({ ...state, doctorDirectory: dir }, { role: "SYSTEM", action: "rebuildDoctorDirectory" });

  if (staffChanged && setStaff) {
    await setDoc(STAFF_DOC, { people: staffList });
    setStaff(staffList);
  }
}

async function grantRole(person, role, staff, setStaff, state, setState) {
  const createStaffAccount = httpsCallable(functions, "createStaffAccount");
  await createStaffAccount({ email: person.email, name: person.name, role });
  const merged = staff.map((p) =>
    (p.idNumber || p.name) === (person.idNumber || person.name) ? { ...p, role } : p
  );
  await setDoc(STAFF_DOC, { people: merged });
  setStaff(merged);
  // Directory is built from category, not role — but email may have just been confirmed,
  // so rebuild to ensure the directory entry has the correct email-based key.
  if (role === "DOCTOR" || person.category === "doctor") await rebuildDoctorDirectory(merged, state, setState, setStaff);
}

async function revokeRole(person, staff, setStaff, state, setState) {
  const revoke = httpsCallable(functions, "revokeStaffAccount");
  await revoke({ email: person.email });
  const merged = staff.map((p) =>
    (p.idNumber || p.name) === (person.idNumber || person.name) ? { ...p, role: null } : p
  );
  await setDoc(STAFF_DOC, { people: merged });
  setStaff(merged);
  // Revoking login no longer affects the operational directory (based on category, not role)
}

/* ─────────────────────────────────────────────
   STAFF IMPORT TAB — upload Excel/CSV only
───────────────────────────────────────────── */
function StaffImportTab({ state, setState }) {
  const [staff, setStaff] = useState([]);
  const [preview, setPreview] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    getDoc(STAFF_DOC).then((snap) => setStaff(snap.exists() ? (snap.data().people || []) : [])).catch(() => {});
  }, []);

  const parseFile = async (file) => {
    if (!file) return;
    setMsg(""); setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const people = [];
      wb.SheetNames.forEach((sheetName) => {
        const sheet = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        const isDoctorSheet = /doctor/i.test(sheetName);
        rows.forEach((r) => {
          const get = (...keys) => {
            for (const want of keys) {
              for (const k of Object.keys(r)) {
                if (k.trim().toLowerCase().includes(want)) {
                  const v = String(r[k]).trim();
                  if (v) return v;
                }
              }
            }
            return "";
          };
          const name = get("name");
          if (!name) return;
          const designation = get("speciality", "designation", "user type") || (isDoctorSheet ? "Doctor" : "Staff");
          const category = isDoctorSheet || /doctor|practitioner|surgeon|physician|dr\.?\s/i.test(designation)
            ? "doctor"
            : /nurse|midwife/i.test(designation)
            ? "nurse"
            : /reception|front\s*desk|clerk/i.test(designation)
            ? "receptionist"
            : /admin|manager|coordinator|supervisor|hr\b/i.test(designation)
            ? "admin_staff"
            : "staff";
          people.push({
            name: name.replace(/\s+/g, " ").trim(),
            idNumber: get("id no", "passport", "id"),
            registrationNo: get("registration", "service no"),
            designation,
            email: get("email"),
            contact: get("contact"),
            category,
            active: true,
          });
        });
      });
      const seen = new Set();
      const deduped = people.filter((p) => {
        const key = (p.idNumber || p.name).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (deduped.length === 0) setMsg("No valid rows found. Make sure the file has a 'Name' column.");
      else setPreview(deduped);
    } catch (e) {
      setMsg("Could not read file: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!preview) return;
    setBusy(true); setMsg("");
    try {
      const byKey = {};
      [...staff, ...preview].forEach((p) => {
        const k = (p.idNumber || p.name).toLowerCase();
        byKey[k] = { ...byKey[k], ...p, role: (staff.find((s) => (s.idNumber || s.name).toLowerCase() === k)?.role) || p.role || null };
      });
      const merged = Object.values(byKey);
      await setDoc(STAFF_DOC, { people: merged });
      setStaff(merged);

      const doctors = merged.filter((p) => p.category === "doctor");
      const dir = { ...(state.doctorDirectory || {}) };
      doctors.forEach((d) => {
        const existing = Object.values(dir).find((x) => x.name === d.name);
        if (existing) {
          existing.specialty = d.designation;
          existing.idNumber = d.idNumber;
          existing.registrationNo = d.registrationNo;
          existing.email = d.email || existing.email || "";
        } else {
          const id = `doc_${Math.random().toString(36).slice(2, 9)}`;
          dir[id] = { id, name: d.name, specialty: d.designation, idNumber: d.idNumber, registrationNo: d.registrationNo, email: d.email || "", active: true };
        }
      });
      await setState({ ...state, doctorDirectory: dir }, { role: "DEVELOPER", action: "staffImport", count: preview.length });
      // Rebuild from the freshly-imported staff list to ensure category-based directory + email keys
      await rebuildDoctorDirectory(merged, { ...state, doctorDirectory: dir }, setState);
      setMsg(`✓ Imported ${preview.length} people (${doctors.length} doctors added to assignment directory). Manage roles in the Staff tab.`);
      setPreview(null);
    } catch (e) {
      setMsg("Import failed: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div className="card">
        <h2 className="card-title">Import Staff &amp; Doctors</h2>
        <p className="dim" style={{ fontSize: "0.83rem", marginBottom: "1rem" }}>
          Upload an Excel (.xlsx) or CSV file. Sheets named with "Doctor" are tagged as doctors and added to the room-assignment directory. After importing, grant login roles in the <strong>Staff</strong> tab.
        </p>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
          onChange={(e) => parseFile(e.target.files?.[0])} />
        <button className="btn btn-blue" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "Reading…" : "Choose file"}
        </button>
        {msg && <div style={{ fontSize: "0.83rem", marginTop: "0.75rem", color: msg.startsWith("✓") ? "var(--green)" : "var(--red)" }}>{msg}</div>}
      </div>

      {preview && (
        <div className="card" style={{ borderColor: "var(--blue)" }}>
          <h2 className="card-title">Preview — {preview.length} people found</h2>
          <div className="table-wrap" style={{ maxHeight: "300px", overflowY: "auto" }}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>ID</th><th>Designation</th><th>Type</th></tr></thead>
              <tbody>
                {preview.map((p, i) => (
                  <tr key={i}>
                    <td>{p.name}</td>
                    <td className="mono" style={{ fontSize: "0.8rem" }}>{p.idNumber || "—"}</td>
                    <td>{p.designation}</td>
                    <td><span className="status-pill" style={{ background: p.category === "doctor" ? "#2563eb22" : "#64748b22", color: p.category === "doctor" ? "#2563eb" : "#64748b" }}>{p.category}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
            <button className="btn btn-green" onClick={confirmImport} disabled={busy}>{busy ? "Importing…" : `Import ${preview.length} people`}</button>
            <button className="btn btn-outline" onClick={() => setPreview(null)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   STAFF DIRECTORY TAB — search, filter, manage roles
───────────────────────────────────────────── */
function StaffDirectoryTab({ state, setState }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"); // all | doctor | staff | login | nologin
  const [msg, setMsg] = useState("");
  const [roleBusy, setRoleBusy] = useState(null);
  const [editing, setEditing] = useState(null); // person being added/edited (form state)
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    getDoc(STAFF_DOC).then((snap) => {
      setStaff(snap.exists() ? (snap.data().people || []) : []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const blankPerson = () => ({ name: "", idNumber: "", registrationNo: "", designation: "", email: "", contact: "", category: "staff", active: true, role: null });

  const openAdd = () => { setEditing(blankPerson()); setIsNew(true); setMsg(""); };
  const openEdit = (person) => { setEditing({ ...person }); setIsNew(false); setMsg(""); };
  const closeForm = () => { setEditing(null); setIsNew(false); };

  const personKey = (p) => (p.idNumber || p.name).toLowerCase();

  const saveForm = async () => {
    const p = editing;
    if (!p.name.trim()) { setMsg("✕ Name is required."); return; }
    const cleaned = {
      ...p,
      name: p.name.replace(/\s+/g, " ").trim(),
      idNumber: p.idNumber.trim(),
      registrationNo: (p.registrationNo || "").trim(),
      designation: (p.designation || "").trim() || (p.category === "doctor" ? "Doctor" : "Staff"),
      email: (p.email || "").trim(),
      contact: (p.contact || "").trim(),
    };
    let merged;
    if (isNew) {
      // Prevent duplicate key
      if (staff.some((s) => personKey(s) === personKey(cleaned))) {
        setMsg("✕ A person with that ID/name already exists.");
        return;
      }
      merged = [...staff, cleaned];
    } else {
      // Replace by original key (editing may change fields)
      const origKey = personKey(staff.find((s) => s === staff.find((x) => personKey(x) === personKey(p))) || p);
      merged = staff.map((s) => (personKey(s) === origKey ? cleaned : s));
    }
    await setDoc(STAFF_DOC, { people: merged });
    setStaff(merged);
    setMsg(`✓ ${isNew ? "Added" : "Updated"} ${cleaned.name}.`);
    closeForm();
  };

  const assign = async (person, role) => {
    if (!person.email) { setMsg(`✕ ${person.name} has no email — cannot create a login.`); return; }
    setRoleBusy(person.email); setMsg("");
    try {
      await grantRole(person, role, staff, setStaff, state, setState);
      // Send the password-setup email via Firebase's built-in service
      try {
        const { sendPasswordResetEmail } = await import("firebase/auth");
        const { auth } = await import("./firebase.js");
        await sendPasswordResetEmail(auth, person.email, {
          url: `${APP_URL}/login`,
          handleCodeInApp: false,
        });
      } catch (mailErr) {
        setMsg(`✓ ${person.name} is now ${role}, but the setup email failed: ${mailErr.message}. They can use "Forgot password" on the login page.`);
        setRoleBusy(null);
        return;
      }
      setMsg(`✓ ${person.name} is now ${role}. A password-setup email was sent to ${person.email}.`);
    } catch (e) {
      setMsg(`✕ Could not assign role: ${e.message}`);
    } finally { setRoleBusy(null); }
  };

  const revoke = async (person) => {
    if (!window.confirm(`Revoke ${person.name}'s login access?`)) return;
    setRoleBusy(person.email); setMsg("");
    try {
      await revokeRole(person, staff, setStaff, state, setState);
      setMsg(`✓ ${person.name}'s access revoked.`);
    } catch (e) {
      setMsg(`✕ Could not revoke: ${e.message}`);
    } finally { setRoleBusy(null); }
  };

  const removePerson = async (person) => {
    if (!window.confirm(`Remove ${person.name} from the directory? (Does not delete their login if they have one.)`)) return;
    const merged = staff.filter((p) => (p.idNumber || p.name) !== (person.idNumber || person.name));
    await setDoc(STAFF_DOC, { people: merged });
    setStaff(merged);
  };

  const roleOptions = (person) => {
    if (person.category === "doctor") return ["DOCTOR", "ADMIN"];
    if (person.category === "receptionist") return ["RECEPTIONIST", "ADMIN"];
    return ["RECEPTIONIST", "ADMIN", "DOCTOR"]; // nurse, admin_staff, other — flexible
  };

  const CATEGORY_LABELS = {
    doctor: "Doctor", nurse: "Nurse", receptionist: "Receptionist",
    admin_staff: "Admin Staff", staff: "Other",
  };
  const CATEGORY_COLORS = {
    doctor: "#2563eb", nurse: "#16a34a", receptionist: "#f59e0b",
    admin_staff: "#a855f7", staff: "#64748b",
  };

  const toggleActive = async (person) => {
    const merged = staff.map((p) =>
      (p.idNumber || p.name) === (person.idNumber || person.name) ? { ...p, active: person.active === false ? true : false } : p
    );
    await setDoc(STAFF_DOC, { people: merged });
    setStaff(merged);
    if (person.category === "doctor") await rebuildDoctorDirectory(merged, state, setState, setStaff);
  };

  // Summary
  const total = staff.length;
  const docCount = staff.filter((p) => p.category === "doctor").length;
  const loginCount = staff.filter((p) => p.role).length;
  const recCount = staff.filter((p) => p.role === "RECEPTIONIST").length;

  // Apply search + filter
  const q = search.trim().toLowerCase();
  const filtered = staff.filter((p) => {
    if (q && !(`${p.name} ${p.designation} ${p.email} ${p.idNumber}`.toLowerCase().includes(q))) return false;
    if (filter === "doctor") return p.category === "doctor";
    if (filter === "nurse") return p.category === "nurse";
    if (filter === "receptionist") return p.category === "receptionist";
    if (filter === "admin_staff") return p.category === "admin_staff";
    if (filter === "other") return !["doctor", "nurse", "receptionist", "admin_staff"].includes(p.category);
    if (filter === "login") return !!p.role;
    if (filter === "nologin") return !p.role;
    return true;
  });

  if (loading) return <div className="card dim">Loading directory…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Summary strip */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "0.75rem", flex: 1 }}>
          {[
            { label: "Total people", value: total },
            { label: "Doctors", value: docCount },
            { label: "With login", value: loginCount },
            { label: "Receptionists", value: recCount },
          ].map((m) => (
            <div key={m.label} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "0.9rem 1rem" }}>
              <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginBottom: "0.3rem" }}>{m.label}</div>
              <div style={{ fontSize: "1.5rem", fontWeight: 600, fontFamily: "'Space Grotesk', sans-serif" }}>{m.value}</div>
            </div>
          ))}
        </div>
        <button className="btn btn-outline btn-sm" style={{ flexShrink: 0 }} onClick={async () => {
          try {
            await rebuildDoctorDirectory(staff, state, setState, setStaff);
            setMsg("✓ Doctor directory rebuilt from staff list.");
          } catch (e) { setMsg("Rebuild failed: " + e.message); }
        }}>↻ Rebuild doctor directory</button>
      </div>

      <div className="card">
        {/* Search + filters */}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1rem", alignItems: "center" }}>
          <input className="field-input" placeholder="Search name, speciality, email…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: "200px" }} />
          <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
            {[["all","All"],["doctor","Doctors"],["nurse","Nurses"],["receptionist","Reception"],["admin_staff","Admin Staff"],["other","Other"],["login","Has login"],["nologin","No login"]].map(([k, label]) => (
              <button key={k} className={`tab-btn${filter === k ? " active" : ""}`} style={{ padding: "0.35rem 0.7rem", fontSize: "0.8rem" }} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
          <button className="btn btn-green" onClick={openAdd}>+ Add person</button>
        </div>

        {msg && <div style={{ fontSize: "0.83rem", marginBottom: "0.75rem", color: msg.startsWith("✓") ? "var(--green)" : "var(--red)" }}>{msg}</div>}

        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Category</th><th>Email</th><th>Login</th><th style={{ width: "170px" }}>Manage</th></tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: "1.5rem" }}>No matching people.</td></tr>
              ) : filtered.map((p, i) => (
                <tr key={i} style={{ opacity: p.active === false ? 0.5 : 1 }}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{p.name}</div>
                    <div className="dim" style={{ fontSize: "0.75rem" }}>{p.designation}{p.idNumber ? ` · ${p.idNumber}` : ""}</div>
                  </td>
                  <td>
                    <span className="status-pill" style={{ background: (CATEGORY_COLORS[p.category] || "#64748b") + "22", color: CATEGORY_COLORS[p.category] || "#64748b", fontSize: "0.75rem" }}>
                      {CATEGORY_LABELS[p.category] || p.category}
                    </span>
                    {p.active === false && <div className="dim" style={{ fontSize: "0.7rem", marginTop: "0.2rem" }}>Inactive</div>}
                  </td>
                  <td className="dim" style={{ fontSize: "0.8rem" }}>{p.email || "—"}</td>
                  <td>{p.role
                    ? <span className="status-pill" style={{ background: "#16a34a22", color: "#16a34a", fontSize: "0.75rem" }}>{p.role}</span>
                    : <span className="dim" style={{ fontSize: "0.8rem" }}>None</span>}</td>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                      <div style={{ display: "flex", gap: "0.3rem" }}>
                        <select className="field-input" style={{ flex: 1, padding: "0.2rem 0.4rem", fontSize: "0.75rem" }}
                          value={p.role || ""} disabled={roleBusy === p.email}
                          onChange={(e) => e.target.value && assign(p, e.target.value)}>
                          <option value="">{roleBusy === p.email ? "…" : "Grant role"}</option>
                          {roleOptions(p).map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                      <div style={{ display: "flex", gap: "0.3rem" }}>
                        {p.role && <button className="btn btn-red btn-sm" style={{ fontSize: "0.72rem", padding: "0.2rem 0.4rem" }} disabled={roleBusy === p.email} onClick={() => revoke(p)}>Revoke</button>}
                        <button className="btn btn-outline btn-sm" style={{ fontSize: "0.72rem", padding: "0.2rem 0.4rem" }} onClick={() => openEdit(p)}>Edit</button>
                        <button className="btn btn-outline btn-sm" style={{ fontSize: "0.72rem", padding: "0.2rem 0.4rem" }} onClick={() => removePerson(p)}>✕</button>
                      </div>
                      <div style={{ display: "flex", gap: "0.3rem" }}>
                        <button className="btn btn-outline btn-sm" style={{ fontSize: "0.72rem", padding: "0.2rem 0.4rem", flex: 1 }} onClick={() => toggleActive(p)}>
                          {p.active === false ? "Mark active" : "Mark inactive"}
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="modal-overlay" onClick={closeForm}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2 className="card-title">{isNew ? "Add Person" : "Edit Person"}</h2>
            <div className="field-group">
              <label className="field-label">Name *</label>
              <input className="field-input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <div className="field-group" style={{ flex: 1, minWidth: "140px" }}>
                <label className="field-label">ID No / Passport</label>
                <input className="field-input" value={editing.idNumber} onChange={(e) => setEditing({ ...editing, idNumber: e.target.value })} />
              </div>
              <div className="field-group" style={{ flex: 1, minWidth: "140px" }}>
                <label className="field-label">Registration No</label>
                <input className="field-input" value={editing.registrationNo} onChange={(e) => setEditing({ ...editing, registrationNo: e.target.value })} />
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <div className="field-group" style={{ flex: 1, minWidth: "140px" }}>
                <label className="field-label">Designation / Speciality</label>
                <input className="field-input" value={editing.designation} onChange={(e) => setEditing({ ...editing, designation: e.target.value })} />
              </div>
              <div className="field-group" style={{ flex: 1, minWidth: "140px" }}>
                <label className="field-label">Category</label>
                <select className="field-input" value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                  <option value="doctor">Doctor</option>
                  <option value="nurse">Nurse</option>
                  <option value="receptionist">Receptionist</option>
                  <option value="admin_staff">Admin Staff</option>
                  <option value="staff">Other</option>
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <div className="field-group" style={{ flex: 1, minWidth: "140px" }}>
                <label className="field-label">Email (needed for login)</label>
                <input className="field-input" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
              </div>
              <div className="field-group" style={{ flex: 1, minWidth: "140px" }}>
                <label className="field-label">Contact</label>
                <input className="field-input" value={editing.contact} onChange={(e) => setEditing({ ...editing, contact: e.target.value })} />
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              <button className="btn btn-green" onClick={saveForm}>{isNew ? "Add to directory" : "Save changes"}</button>
              <button className="btn btn-outline" onClick={closeForm}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/* ─────────────────────────────────────────────
   ADMIN EMAILS TAB — manage Google accounts for Admin role
───────────────────────────────────────────── */
function AdminEmailsTab({ state, setState }) {
  const [newEmail, setNewEmail] = useState("");
  const [msg, setMsg] = useState("");
  const adminEmails = state.adminEmails || [];

  const add = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) { setMsg("✕ Enter a valid email address."); return; }
    if (adminEmails.includes(email)) { setMsg("✕ That email is already an Admin."); return; }
    const updated = [...adminEmails, email];
    await setState({ ...state, adminEmails: updated }, { role: "DEVELOPER", action: "addAdminEmail", email });
    setNewEmail("");
    setMsg(`✓ ${email} added as Admin.`);
  };

  const remove = async (email) => {
    if (!window.confirm(`Remove ${email} from Admin access?`)) return;
    const updated = adminEmails.filter((e) => e !== email);
    await setState({ ...state, adminEmails: updated }, { role: "DEVELOPER", action: "removeAdminEmail", email });
    setMsg(`✓ ${email} removed.`);
  };

  return (
    <div className="card">
      <h2 className="card-title">Admin Google Accounts</h2>
      <p className="dim" style={{ fontSize: "0.83rem", marginBottom: "1.25rem" }}>
        Google accounts listed here get the <strong>Admin</strong> role when they sign in via <code>/login</code>. Your Developer email is separate and managed via <code>.env</code>.
      </p>
      <div className="add-row">
        <input className="field-input" placeholder="admin@example.com" value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn btn-green" onClick={add}>+ Add</button>
      </div>
      {msg && <div style={{ fontSize: "0.83rem", marginBottom: "0.75rem", color: msg.startsWith("✓") ? "var(--green)" : "var(--red)" }}>{msg}</div>}
      {adminEmails.length === 0
        ? <div className="dim">No Admin accounts yet. Add a Google email above.</div>
        : (
          <div className="divide-list">
            {adminEmails.map((email) => (
              <div key={email} className="divide-row">
                <div>
                  <div className="fw-med">{email}</div>
                  <div className="dim" style={{ fontSize: "0.8rem" }}>Signs in via Google · Admin role</div>
                </div>
                <button className="btn btn-red btn-sm" onClick={() => remove(email)}>Remove</button>
              </div>
            ))}
          </div>
        )
      }
    </div>
  );
}

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
   RECEPTION PORTAL — receptionist lands here
───────────────────────────────────────────── */
function ReceptionPortal() {
  const { state, setRoom, ready } = useClinicState();
  const [tab, setTab] = useState("appointments");
  if (!ready) return <div className="portal-bg"><div className="portal-container"><div className="card dim">Loading…</div></div></div>;

  const activeDoctors = Object.values(state.doctorDirectory || {}).filter((d) => d.active);

  const assign = async (roomId, doctorId) => {
    const d = doctorId ? state.doctorDirectory[doctorId] : null;
    await setRoom(roomId, {
      assigned: d ? { id: d.id, name: d.name, department: d.specialty || "General", email: d.email || "" } : null,
      status: "IDLE", sessions: null, nowServing: null, upNext: null, customCall: null,
    }, { role: "RECEPTION", action: "assignDoctor", roomId, doctorId });
    // Update today's waiting visits for this doctor to set their room
    if (d) {
      const today = new Date().toISOString().slice(0, 10);
      try {
        const q1 = query(VISITS_COL, where("doctorId", "==", d.id), where("date", "==", today), where("status", "==", "waiting"));
        const q2 = query(VISITS_COL, where("doctorName", "==", d.name), where("date", "==", today), where("status", "==", "waiting"));
        const [snap1, snap2] = await Promise.all([getDocs(q1), getDocs(q2)]);
        const seen = new Set();
        const updates = [];
        [...snap1.docs, ...snap2.docs].forEach((d) => {
          if (!seen.has(d.id)) {
            seen.add(d.id);
            updates.push(setDoc(d.ref, { room: roomId }, { merge: true }));
          }
        });
        await Promise.all(updates);
      } catch (e) { console.warn("visit room update failed:", e.message); }
    }
  };

  const endSession = async (roomId) => {
    if (!window.confirm(`End session for ${roomId}?`)) return;
    await setRoom(roomId, {
      assigned: null, sessions: null, nowServing: null, upNext: null, customCall: null, status: "SESSION ENDED",
    }, { role: "RECEPTION", action: "endSession", roomId });
  };

  const clearAllRooms = async () => {
    const assignedCount = (state.rooms || []).filter((r) => state.assigned[r]).length;
    if (assignedCount === 0) { alert("No rooms are currently assigned."); return; }
    if (!window.confirm(`Clear all ${assignedCount} room assignment(s)? Doctors will need to be re-assigned.`)) return;
    await Promise.all((state.rooms || DEFAULT_ROOMS).map((r) =>
      setRoom(r, {
        assigned: null, sessions: null, nowServing: null, upNext: null, customCall: null, status: "IDLE",
      }, { role: "RECEPTION", action: "clearAllRooms", roomId: r })
    ));
  };

  return (
    <div className="portal-bg">
      <div className="portal-container" style={{ maxWidth: "960px" }}>
        <div className="portal-header">
          <div>
            <h1 className="portal-title">Reception</h1>
            <div className="portal-sub">Room assignment · Patients · Appointments</div>
          </div>
        </div>
        <div className="tab-bar">
          {["appointments", "active", "patients", "rooms"].map((t) => (
            <button key={t} className={`tab-btn${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {t === "appointments" ? "📋 Book Appointment" : t === "active" ? "📅 Active Appointments" : t === "patients" ? "👤 Patients" : "🏥 Rooms"}
            </button>
          ))}
        </div>
        {tab === "rooms" && (
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h2 className="card-title" style={{ margin: 0 }}>Assign Doctors to Rooms</h2>
              <button className="btn btn-outline btn-sm" onClick={clearAllRooms}>Clear all assignments</button>
            </div>
            <div className="divide-list">
              {(state.rooms || DEFAULT_ROOMS).map((r) => (
                <div key={r} className="divide-row">
                  <div style={{ minWidth: "120px" }}>
                    <div className="fw-med mono">{roomDisplay(r)}</div>
                    <div className="dim" style={{ fontSize: "0.82rem" }}>
                      <span className="status-pill" style={{ background: statusColor(state.status[r]) + "22", color: statusColor(state.status[r]) }}>{friendlyStatus(state.status[r])}</span>
                    </div>
                  </div>
                  <select className="field-input" style={{ flex: 1 }}
                    value={state.assigned[r]?.id || ""}
                    onChange={(e) => assign(r, e.target.value || null)}>
                    <option value="">— Unassigned —</option>
                    {activeDoctors.map((d) => (
                      <option key={d.id} value={d.id}>{d.name} ({d.specialty || "General"})</option>
                    ))}
                  </select>
                  <div className="btn-group">
                    <span className="dim mono" style={{ fontSize: "0.85rem", minWidth: "24px" }}>
                      {state.nowServing[r] ? `#${state.nowServing[r]}` : "—"}
                    </span>
                    <button className="btn btn-red btn-sm" onClick={() => endSession(r)}>End</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === "patients" && <PatientRecordsTab />}
        {tab === "appointments" && <BookAppointmentTab state={state} />}
        {tab === "active" && <ActiveAppointmentsTab state={state} />}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   PATIENT RECORDS TAB
───────────────────────────────────────────── */
function PatientRecordsTab() {
  const [idInput, setIdInput] = useState("");
  const [phase, setPhase] = useState("search"); // search | found | notfound | editing
  const [patient, setPatient] = useState(null);
  const [form, setForm] = useState({ idNumber: "", name: "", mobile: "", dob: "", sex: "", category: "General", policeServiceNo: "", address: "", notes: "" });
  const [msg, setMsg] = useState("");
  const [searching, setSearching] = useState(false);

  const lookup = async () => {
    const id = idInput.trim();
    if (!id) return;
    setSearching(true); setMsg("");
    try {
      const snap = await getDoc(doc(db, "clinicq_patients", id));
      if (snap.exists()) {
        const p = { id: snap.id, ...snap.data() };
        setPatient(p);
        setForm({ idNumber: p.idNumber || id, name: p.name || "", mobile: p.mobile || "", dob: p.dob || "", sex: p.sex || "", category: p.category || "General", policeServiceNo: p.policeServiceNo || "", address: p.address || "", notes: p.notes || "" });
        setPhase("found");
      } else {
        setForm({ idNumber: id, name: "", mobile: "", dob: "", sex: "", address: "", notes: "" });
        setPhase("notfound");
      }
    } catch (e) { setMsg("Lookup failed: " + e.message); }
    finally { setSearching(false); }
  };

  const save = async () => {
    if (!form.name.trim()) { setMsg("Name is required."); return; }
    try {
      await setDoc(doc(db, "clinicq_patients", form.idNumber.trim()), {
        idNumber: form.idNumber.trim(), name: form.name.trim(), mobile: form.mobile.trim(),
        dob: form.dob, sex: form.sex, address: form.address.trim(), notes: form.notes.trim(),
        updatedAt: Date.now(),
      }, { merge: true });
      setMsg(`✓ ${form.name.trim()} ${phase === "notfound" ? "added" : "updated"}.`);
      setPhase("found");
      setPatient({ ...form });
    } catch (e) { setMsg("Save failed: " + e.message); }
  };

  const reset = () => { setIdInput(""); setPhase("search"); setPatient(null); setMsg(""); };

  return (
    <div className="card">
      <h2 className="card-title">Patient Records</h2>
      {phase === "search" && (
        <div>
          <div className="add-row">
            <input className="field-input" placeholder="Enter ID / Passport No" value={idInput}
              onChange={(e) => setIdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && lookup()} />
            <button className="btn btn-blue" onClick={lookup} disabled={searching}>{searching ? "Searching…" : "Look up"}</button>
          </div>
          {msg && <div style={{ fontSize: "0.83rem", color: "var(--red)" }}>{msg}</div>}
        </div>
      )}

      {phase === "found" && patient && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: "1.1rem" }}>{patient.name}</div>
              <div className="dim" style={{ fontSize: "0.83rem" }}>{patient.idNumber} · {patient.dob ? `${patient.dob} (${computeAge(patient.dob)})` : patient.age ? `Age ${patient.age}` : ""} · {patient.sex || ""}</div>
              <div className="dim" style={{ fontSize: "0.83rem" }}>{patient.mobile || ""} {patient.address ? `· ${patient.address}` : ""}</div>
            </div>
            <div className="btn-group">
              <button className="btn btn-outline btn-sm" onClick={() => setPhase("editing")}>Edit</button>
              <button className="btn btn-outline btn-sm" onClick={reset}>Search again</button>
            </div>
          </div>
          {msg && <div style={{ fontSize: "0.83rem", color: msg.startsWith("✓") ? "var(--green)" : "var(--red)" }}>{msg}</div>}
        </div>
      )}

      {phase === "notfound" && (
        <div>
          <div style={{ padding: "0.75rem", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "8px", marginBottom: "1rem", fontSize: "0.85rem" }}>
            No patient found with ID <strong>{idInput}</strong>. Fill in details below to add them.
          </div>
          <PatientFormFields form={form} setForm={setForm} />
          {msg && <div style={{ fontSize: "0.83rem", color: msg.startsWith("✓") ? "var(--green)" : "var(--red)", marginBottom: "0.5rem" }}>{msg}</div>}
          <div className="btn-group">
            <button className="btn btn-green" onClick={save}>Add patient</button>
            <button className="btn btn-outline" onClick={reset}>Cancel</button>
          </div>
        </div>
      )}

      {phase === "editing" && (
        <div>
          <PatientFormFields form={form} setForm={setForm} lockId />
          {msg && <div style={{ fontSize: "0.83rem", color: msg.startsWith("✓") ? "var(--green)" : "var(--red)", marginBottom: "0.5rem" }}>{msg}</div>}
          <div className="btn-group">
            <button className="btn btn-green" onClick={save}>Save changes</button>
            <button className="btn btn-outline" onClick={() => setPhase("found")}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PatientFormFields({ form, setForm, lockId }) {
  return (
    <div>
      <div className="field-group">
        <label className="field-label">ID / Passport No *</label>
        <input className="field-input" value={form.idNumber} disabled={lockId} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} />
      </div>
      <div className="field-group">
        <label className="field-label">Full Name *</label>
        <input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <div className="field-group" style={{ flex: 1, minWidth: "130px" }}>
          <label className="field-label">Mobile</label>
          <input className="field-input" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
        </div>
        <div className="field-group" style={{ flex: 1, minWidth: "130px" }}>
          <label className="field-label">DOB {form.dob ? `(age ${computeAge(form.dob)})` : ""}</label>
          <input type="date" className="field-input" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} />
        </div>
        <div className="field-group" style={{ flex: "0 0 90px" }}>
          <label className="field-label">Sex</label>
          <select className="field-input" value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}>
            <option value="">—</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
            <option value="Other">Other</option>
          </select>
        </div>
      </div>
      <div className="field-group">
        <label className="field-label">Patient Category</label>
        <select className="field-input" value={form.category || "General"} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          <option value="General">General</option>
          <option value="Police">Police</option>
          <option value="Police EXO">Police EXO</option>
          <option value="Police Family">Police Family</option>
          <option value="Emergency">Emergency</option>
          <option value="Police Custody">Police Custody</option>
        </select>
      </div>
      {["Police", "Police EXO", "Police Family", "Police Custody", "Emergency"].includes(form.category) && (
        <div className="field-group">
          <label className="field-label">Police Service No <span className="dim" style={{ fontWeight: 400 }}>(4-digit)</span></label>
          <input
            className="field-input"
            style={{ maxWidth: "140px" }}
            maxLength={4}
            placeholder="e.g. 1234"
            value={form.policeServiceNo || ""}
            onChange={(e) => setForm({ ...form, policeServiceNo: e.target.value.replace(/\D/g, "").slice(0, 4) })}
          />
        </div>
      )}
      <div className="field-group">
        <label className="field-label">Address</label>
        <input className="field-input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
      </div>
      <div className="field-group">
        <label className="field-label">Notes</label>
        <input className="field-input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. wheelchair, follow-up" />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   BOOK APPOINTMENT TAB — two-step: ID lookup → book
───────────────────────────────────────────── */
function BookAppointmentTab({ state }) {
  const [idInput, setIdInput] = useState("");
  const [phase, setPhase] = useState("lookup"); // lookup | newpatient | book
  const [patientForm, setPatientForm] = useState({ idNumber: "", name: "", mobile: "", dob: "", sex: "", category: "General", policeServiceNo: "", address: "", notes: "" });
  const [doctorId, setDoctorId] = useState("");
  const [apptDate, setApptDate] = useState(new Date().toISOString().slice(0, 10));
  const [consultationType, setConsultationType] = useState("Walk-in");
  const [isFollowUp, setIsFollowUp] = useState(false);
  const [lastVisitInfo, setLastVisitInfo] = useState(null);
  const [editingPatient, setEditingPatient] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [lookupMsg, setLookupMsg] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastTicket, setLastTicket] = useState(null);

  const activeDoctors = Object.values(state.doctorDirectory || {}).filter((d) => d.active);

  // Find room for a doctor
  const roomForDoctor = (docId) => {
    const entry = Object.entries(state.assigned || {}).find(([, a]) => a?.id === docId);
    return entry ? entry[0] : null;
  };

  const lookup = async () => {
    const id = idInput.trim();
    if (!id) return;
    setLookupMsg("Searching…"); setMsg(""); setLastVisitInfo(null);
    setEditingPatient(false); setConsultationType("Walk-in"); setIsFollowUp(false);
    setDoctorId(""); setLastTicket(null);
    try {
      const snap = await getDoc(doc(db, "clinicq_patients", id));
      if (snap.exists()) {
        const p = snap.data();
        setPatientForm({ idNumber: id, name: p.name || "", mobile: p.mobile || "", dob: p.dob || "", sex: p.sex || "", category: p.category || "General", policeServiceNo: p.policeServiceNo || "", address: p.address || "", notes: p.notes || "" });
        setLookupMsg(`✓ Returning patient — ${p.name}`);
        setPhase("book");
        // Fetch most recent visit for follow-up context
        try {
          const q = query(VISITS_COL, where("patientId", "==", id), orderBy("createdAt", "desc"), limit(1));
          const visitSnap = await getDocs(q);
          if (!visitSnap.empty) {
            const lastVisit = visitSnap.docs[0].data();
            const lastDate = new Date(lastVisit.createdAt);
            const daysAgo = Math.floor((Date.now() - lastVisit.createdAt) / 86400000);
            setLastVisitInfo({ date: lastVisit.date, daysAgo, doctorName: lastVisit.doctorName });
            if (daysAgo <= 5) setIsFollowUp(true);
          }
        } catch (e) { console.warn("lastVisit lookup:", e.message); }
      } else {
        setPatientForm({ idNumber: id, name: "", mobile: "", dob: "", sex: "", category: "General", address: "", notes: "" });
        setLookupMsg("");
        setPhase("newpatient");
      }
    } catch (e) { setLookupMsg("Lookup failed: " + e.message); }
  };

  const saveNewAndProceed = async () => {
    if (!patientForm.name.trim()) { setMsg("Name is required."); return; }
    setBusy(true);
    try {
      await setDoc(doc(db, "clinicq_patients", patientForm.idNumber.trim()), {
        ...patientForm, idNumber: patientForm.idNumber.trim(), updatedAt: Date.now(),
      }, { merge: true });
      setMsg("✓ Patient added.");
      setPhase("book");
    } catch (e) { setMsg("Save failed: " + e.message); }
    finally { setBusy(false); }
  };

  const saveEdit = async () => {
    if (!patientForm.name.trim()) { setMsg("Name is required."); return; }
    setEditSaving(true);
    try {
      await setDoc(doc(db, "clinicq_patients", patientForm.idNumber.trim()), {
        ...patientForm, idNumber: patientForm.idNumber.trim(), updatedAt: Date.now(),
      }, { merge: true });
      setMsg("✓ Patient details updated.");
      setEditingPatient(false);
    } catch (e) { setMsg("Update failed: " + e.message); }
    finally { setEditSaving(false); }
  };

  const book = async () => {
    if (!doctorId) { setMsg("Please select a doctor."); return; }
    const doctor = state.doctorDirectory[doctorId];
    const room = roomForDoctor(doctorId) || "";  // room may not be assigned yet — that's ok
    setBusy(true); setMsg("");
    try {
      const id = patientForm.idNumber.trim();
      const now = Date.now();
      await setDoc(doc(db, "clinicq_patients", id), {
        ...patientForm, idNumber: id, lastVisit: apptDate, updatedAt: now,
      }, { merge: true });
      const token = await nextTokenForDoctor(doctorId, apptDate);
      await addDoc(VISITS_COL, {
        patientId: id, name: patientForm.name.trim(), room, doctorId,
        doctorName: doctor.name, token, date: apptDate, status: "waiting", createdAt: now,
        patientCategory: patientForm.category || "General",
        policeServiceNo: patientForm.policeServiceNo || "",
        consultationType, isFollowUp,
      });
      const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setLastTicket({ token, room, doctorId, doctorName: doctor.name, name: patientForm.name.trim(), date: apptDate, time: timeStr });
      setMsg(`✓ ${patientForm.name.trim()} booked — Token ${token} · ${doctor.name} · ${apptDate}`);
      setIdInput(""); setPatientForm({ idNumber: "", name: "", mobile: "", dob: "", sex: "", category: "General", policeServiceNo: "", address: "", notes: "" });
      setDoctorId(""); setPhase("lookup"); setLookupMsg(""); setConsultationType("Walk-in"); setIsFollowUp(false); setLastVisitInfo(null);
    } catch (e) { setMsg("Booking failed: " + e.message); }
    finally { setBusy(false); }
  };

  const printTicket = async () => {
    if (!lastTicket) return;
    const t = lastTicket;
    const trackUrl = `${APP_URL}/#track?token=${t.token}&room=${t.room}&doctor=${t.doctorId || ""}&date=${t.date}`;
    const qrDataUrl = await generateQRDataURL(trackUrl);
    const w = window.open("", "_blank", "width=320,height=500");
    w.document.write(`<html><head><title>Token ${t.token}</title>
      <style>
        body{font-family:system-ui,sans-serif;text-align:center;padding:16px;max-width:280px;margin:0 auto;color:#000;background:#fff}
        .clinic{font-size:14px;font-weight:700;margin-bottom:4px}
        .token{font-size:80px;font-weight:900;margin:6px 0;line-height:1;color:#000}
        .row{font-size:12px;margin:3px 0;color:#333}
        .label{color:#888;font-size:9px;text-transform:uppercase;letter-spacing:1px}
        hr{border:none;border-top:1px dashed #ccc;margin:8px 0}
        img.qr{width:130px;height:130px;display:block;margin:8px auto}
      </style></head><body>
      <div class="clinic">${CLINIC_NAME}</div>
      <hr/>
      <div class="label">Token Number</div>
      <div class="token">${t.token}</div>
      <div class="row"><strong>${t.doctorName || roomDisplay(t.room)}</strong></div>
      <div class="row">${t.date} &middot; ${t.time}</div>
      <hr/>
      ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR"/>` : ""}
      <div class="label">Scan to track your queue position</div>
      <script>setTimeout(()=>window.print(),300);</script>
      </body></html>`);
    w.document.close(); w.focus();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div className="card">
        <h2 className="card-title">Book Appointment</h2>

        {/* Step 1: Search patient */}
        <div className="field-group">
          <label className="field-label">Patient ID / Passport</label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input className="field-input" placeholder="Type ID and press Enter or Search" value={idInput}
              onChange={(e) => setIdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && lookup()} />
            <button className="btn btn-blue" onClick={lookup}>🔍 Search</button>
          </div>
          {lookupMsg && <div style={{ fontSize: "0.8rem", marginTop: "0.4rem", color: lookupMsg.startsWith("✓") ? "var(--green)" : "var(--text-dim)" }}>{lookupMsg}</div>}
        </div>

        {/* New patient form */}
        {phase === "newpatient" && (
          <div style={{ padding: "1rem", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "8px", marginBottom: "0.75rem" }}>
            <div style={{ fontWeight: 600, marginBottom: "0.75rem", fontSize: "0.9rem" }}>New patient — fill in details</div>
            <PatientFormFields form={patientForm} setForm={setPatientForm} lockId />
            <div className="btn-group" style={{ marginTop: "0.5rem" }}>
              <button className="btn btn-green" onClick={saveNewAndProceed} disabled={busy}>{busy ? "Saving…" : "Save & continue to booking"}</button>
            </div>
          </div>
        )}

        {/* Step 2: Book */}
        {phase === "book" && (
          <div>
            {editingPatient ? (
              <div style={{ padding: "1rem", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", marginBottom: "1rem" }}>
                <div style={{ fontWeight: 600, marginBottom: "0.75rem", fontSize: "0.9rem" }}>Edit patient details</div>
                <PatientFormFields form={patientForm} setForm={setPatientForm} lockId />
                <div className="btn-group" style={{ marginTop: "0.5rem" }}>
                  <button className="btn btn-green" onClick={saveEdit} disabled={editSaving}>{editSaving ? "Saving…" : "Save changes"}</button>
                  <button className="btn btn-outline" onClick={() => setEditingPatient(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div style={{ padding: "0.75rem", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", marginBottom: "1rem", fontSize: "0.85rem", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                <div>
                  <strong>{patientForm.name}</strong> · {patientForm.idNumber}
                  {patientForm.dob && ` · Age ${computeAge(patientForm.dob)}`}
                  {patientForm.mobile && ` · ${patientForm.mobile}`}
                  {patientForm.category && patientForm.category !== "General" && ` · ${patientForm.category}`}
                </div>
                <button className="btn btn-outline btn-sm" onClick={() => setEditingPatient(true)}>✏️ Edit</button>
              </div>
            )}
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <div className="field-group" style={{ flex: 1, minWidth: "200px" }}>
                <label className="field-label">Step 2 — Select Doctor *</label>
                <select className="field-input" value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                  <option value="">— Select doctor —</option>
                  {activeDoctors.map((d) => {
                    const room = roomForDoctor(d.id);
                    return (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.specialty || "General"}){room ? ` · ${roomDisplay(room)}` : " · Not assigned"}
                      </option>
                    );
                  })}
                </select>
                {doctorId && !roomForDoctor(doctorId) && (
                  <div style={{ fontSize: "0.78rem", color: "var(--yellow)", marginTop: "0.3rem" }}>
                    Room not yet assigned — token will be reserved for this doctor.
                  </div>
                )}
              </div>
              <div className="field-group" style={{ flex: "0 0 160px" }}>
                <label className="field-label">Appointment Date</label>
                <input type="date" className="field-input" value={apptDate} onChange={(e) => setApptDate(e.target.value)} />
              </div>
            </div>

            {/* Consultation type + Follow-up */}
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.5rem", alignItems: "flex-start" }}>
              <div className="field-group" style={{ flex: "0 0 200px" }}>
                <label className="field-label">Consultation Type</label>
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  <button type="button" className={`btn btn-sm ${consultationType === "Walk-in" ? "btn-blue" : "btn-outline"}`} style={{ flex: 1 }} onClick={() => setConsultationType("Walk-in")}>Walk-in</button>
                  <button type="button" className={`btn btn-sm ${consultationType === "Online" ? "btn-blue" : "btn-outline"}`} style={{ flex: 1 }} onClick={() => setConsultationType("Online")}>Online</button>
                </div>
              </div>
              <div className="field-group" style={{ flex: 1, minWidth: "220px" }}>
                <label className="field-label">&nbsp;</label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", cursor: "pointer", padding: "0.45rem 0" }}>
                  <input type="checkbox" checked={isFollowUp} onChange={(e) => setIsFollowUp(e.target.checked)} />
                  Follow-up visit
                </label>
                {lastVisitInfo && (
                  <div style={{ fontSize: "0.78rem", color: "var(--text-dim)", marginTop: "0.1rem" }}>
                    Last visit: {lastVisitInfo.daysAgo === 0 ? "today" : `${lastVisitInfo.daysAgo} day${lastVisitInfo.daysAgo === 1 ? "" : "s"} ago`}
                    {lastVisitInfo.doctorName ? ` with ${lastVisitInfo.doctorName}` : ""}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {msg && <div style={{ fontSize: "0.85rem", marginBottom: "0.75rem", color: msg.startsWith("✓") ? "var(--green)" : "var(--red)" }}>{msg}</div>}

        {phase === "book" && (
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-green" onClick={book} disabled={busy || !doctorId}>
              {busy ? "Booking…" : "Book & assign token"}
            </button>
            {lastTicket && <button className="btn btn-blue" onClick={printTicket}>🖨 Print token {lastTicket.token}</button>}
          </div>
        )}

        {lastTicket && (
          <div style={{ marginTop: "1rem", padding: "1rem", background: "var(--bg)", borderRadius: "10px", display: "flex", alignItems: "center", gap: "1.25rem" }}>
            <LobbyQR url={`${APP_URL}/#track?token=${lastTicket.token}&room=${lastTicket.room}&doctor=${lastTicket.doctorId || ""}&date=${lastTicket.date}`} dark={false} />
            <div>
              <div style={{ fontWeight: 700 }}>Token {lastTicket.token}</div>
              <div style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>{roomDisplay(lastTicket.room)} · {lastTicket.doctorName}</div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>Patient can scan to track queue</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   ACTIVE APPOINTMENTS TAB
───────────────────────────────────────────── */
function ActiveAppointmentsTab({ state }) {
  const [visits, setVisits] = useState([]);
  const [viewDate, setViewDate] = useState(new Date().toISOString().slice(0, 10));
  const [filterDoctor, setFilterDoctor] = useState("");
  const activeDoctors = Object.values(state.doctorDirectory || {}).filter((d) => d.active);

  const load = async () => {
    try {
      const q = query(VISITS_COL, where("date", "==", viewDate), limit(200));
      const snap = await getDocs(q);
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      list.sort((a, b) => {
        if (a.room !== b.room) return a.room.localeCompare(b.room);
        return (a.token || 0) - (b.token || 0);
      });
      setVisits(list);
    } catch (e) {
      console.warn("loadVisits:", e.message);
      setMsg("Could not load appointments: " + e.message);
    }
  };
  useEffect(() => { load(); }, [viewDate]);

  const cancel = async (id) => {
    if (!window.confirm("Cancel this appointment?")) return;
    await setDoc(doc(db, "clinicq_visits", id), { status: "cancelled" }, { merge: true });
    load();
  };

  const reprint = async (v) => {
    const trackUrl = `${APP_URL}/#track?token=${v.token}&room=${v.room}&doctor=${v.doctorId || ""}&date=${v.date}`;
    const time = new Date(v.createdAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const qrDataUrl = await generateQRDataURL(trackUrl);
    const w = window.open("", "_blank", "width=320,height=500");
    w.document.write(`<html><head><title>Token ${v.token}</title>
      <style>
        body{font-family:system-ui,sans-serif;text-align:center;padding:16px;max-width:280px;margin:0 auto;color:#000;background:#fff}
        .clinic{font-size:14px;font-weight:700;margin-bottom:4px}
        .token{font-size:80px;font-weight:900;margin:6px 0;line-height:1;color:#000}
        .row{font-size:12px;margin:3px 0;color:#333}
        .label{color:#888;font-size:9px;text-transform:uppercase;letter-spacing:1px}
        hr{border:none;border-top:1px dashed #ccc;margin:8px 0}
        img.qr{width:130px;height:130px;display:block;margin:8px auto}
      </style></head><body>
      <div class="clinic">${CLINIC_NAME}</div>
      <hr/>
      <div class="label">Token Number</div>
      <div class="token">${v.token}</div>
      <div class="row"><strong>${v.doctorName || roomDisplay(v.room)}</strong></div>
      <div class="row">${v.date} &middot; ${time}</div>
      <hr/>
      ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR"/>` : ""}
      <div class="label">Scan to track your queue position</div>
      <script>setTimeout(()=>window.print(),300);</script>
      </body></html>`);
    w.document.close(); w.focus();
  };

  const filtered = filterDoctor ? visits.filter((v) => v.doctorId === filterDoctor || v.doctorName === filterDoctor) : visits;
  const waiting = filtered.filter((v) => v.status === "waiting").length;
  const served = filtered.filter((v) => v.status === "served").length;
  const cancelled = filtered.filter((v) => v.status === "cancelled" || v.status === "cleared").length;

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2 className="card-title" style={{ margin: 0 }}>Appointments</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <input type="date" className="field-input" style={{ width: "auto" }} value={viewDate} onChange={(e) => setViewDate(e.target.value)} />
          <select className="field-input" style={{ width: "auto" }} value={filterDoctor} onChange={(e) => setFilterDoctor(e.target.value)}>
            <option value="">All doctors</option>
            {activeDoctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="btn btn-outline btn-sm" onClick={load}>↻</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        {[["Waiting", waiting, "#16a34a"], ["Served", served, "#64748b"], ["Cancelled/Cleared", cancelled, "#ef4444"]].map(([label, count, color]) => (
          <div key={label} style={{ padding: "0.5rem 0.75rem", background: color + "11", borderRadius: "8px", fontSize: "0.83rem" }}>
            <span style={{ color, fontWeight: 600 }}>{count}</span> <span className="dim">{label}</span>
          </div>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="dim">No appointments for this date.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>#</th><th>Patient</th><th>Doctor</th><th>Room</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {filtered.map((v) => (
                <tr key={v.id} style={{ opacity: v.status === "cancelled" || v.status === "cleared" ? 0.45 : 1 }}>
                  <td style={{ fontWeight: 700 }}>{v.token}</td>
                  <td>{v.name}</td>
                  <td>{v.doctorName || "—"}</td>
                  <td className="mono" style={{ fontSize: "0.85rem" }}>
                    {(() => {
                      if (v.room) return roomDisplay(v.room);
                      // Look up doctor's current room from live state
                      const assignedRoom = Object.entries(state.assigned || {}).find(
                        ([, a]) => a && (a.id === v.doctorId || a.name === v.doctorName)
                      );
                      return assignedRoom
                        ? <span style={{ color: "var(--blue)" }}>{roomDisplay(assignedRoom[0])}</span>
                        : <span className="dim">Not assigned</span>;
                    })()}
                  </td>
                  <td>
                    <span className="status-pill" style={{
                      background: v.status === "served" ? "#64748b22" : v.status === "cancelled" || v.status === "cleared" ? "#ef444422" : "#16a34a22",
                      color: v.status === "served" ? "#64748b" : v.status === "cancelled" || v.status === "cleared" ? "#ef4444" : "#16a34a",
                    }}>{v.status}</span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: "0.3rem" }}>
                      <button className="btn btn-outline btn-sm" onClick={() => reprint(v)} title="Reprint token">🖨</button>
                      {v.status === "waiting" && (
                        <button className="btn btn-outline btn-sm" onClick={() => cancel(v.id)}>Cancel</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}



/* ─────────────────────────────────────────────
   PATIENT HELPERS
───────────────────────────────────────────── */
function computeAge(dob) {
  if (!dob) return "";
  const d = new Date(dob);
  if (isNaN(d)) return "";
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 150 ? age : "";
}

// Next token for a room today = highest existing today + 1
// Generate QR code as a base64 data URL — no CDN needed in print window
async function generateQRDataURL(url) {
  try {
    const QRCode = await import("qrcode");
    return await QRCode.toDataURL(url, {
      width: 160, margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch {
    return null;
  }
}

async function nextTokenForDoctor(doctorId, date) {
  const d = date || new Date().toISOString().slice(0, 10);
  // Only count active visits (not cancelled/cleared) to avoid gaps from test/cancelled bookings
  const q = query(VISITS_COL,
    where("doctorId", "==", doctorId),
    where("date", "==", d),
    where("status", "in", ["waiting", "served"])
  );
  const snap = await getDocs(q);
  let max = 0;
  snap.forEach((doc) => { const t = doc.data().token || 0; if (t > max) max = t; });
  return max + 1;
}

async function nextTokenForRoom(room, date) {
  const d = date || new Date().toISOString().slice(0, 10);
  const q = query(VISITS_COL,
    where("room", "==", room),
    where("date", "==", d),
    where("status", "in", ["waiting", "served"])
  );
  const snap = await getDocs(q);
  let max = 0;
  snap.forEach((doc) => { const t = doc.data().token || 0; if (t > max) max = t; });
  return max + 1;
}

/* ─────────────────────────────────────────────
   PATIENT IMPORT TAB — bulk import from Excel/CSV
───────────────────────────────────────────── */
function PatientImportTab() {
  const [preview, setPreview] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const fileRef = useRef(null);

  const parseFile = async (file) => {
    if (!file) return;
    setMsg(""); setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const get = (r, ...keys) => {
        for (const want of keys) {
          for (const k of Object.keys(r)) {
            if (k.trim().toLowerCase().replace(/\s+/g, "") === want.toLowerCase().replace(/\s+/g, "")) {
              const v = String(r[k]).trim();
              if (v) return v;
            }
          }
        }
        return "";
      };

      const patients = [];
      const seen = new Set();
      rows.forEach((r) => {
        const id = get(r, "NID", "ID", "idnumber", "patientid", "id no", "passport");
        const name = get(r, "patient name", "name", "patientname", "fullname");
        if (!id || !name) return;
        if (seen.has(id.toLowerCase())) return;
        seen.add(id.toLowerCase());
        const age = get(r, "age");
        const sex = get(r, "sex", "gender");
        const mobile = get(r, "mobile", "phone", "contact", "tel");
        const address = get(r, "address");
        const notes = get(r, "notes", "remarks");
        patients.push({ idNumber: id, name, age: age ? parseInt(age) || "" : "", sex, mobile, address, notes });
      });

      if (patients.length === 0) {
        setMsg("No valid rows found. Make sure the file has NID and Patient Name columns.");
      } else {
        setPreview(patients);
      }
    } catch (e) {
      setMsg("Could not read file: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!preview) return;
    setBusy(true); setMsg(""); setProgress(0);
    const BATCH = 200; // Firestore limit per batch write would be 500 but keep it safe
    let done = 0;
    try {
      // Write in chunks to avoid overwhelming Firestore
      for (let i = 0; i < preview.length; i++) {
        const p = preview[i];
        await setDoc(doc(db, "clinicq_patients", p.idNumber), {
          idNumber: p.idNumber,
          name: p.name,
          age: p.age || "",
          sex: p.sex || "",
          mobile: p.mobile || "",
          address: p.address || "",
          notes: p.notes || "",
          dob: "",
          lastVisit: "",
          importedAt: Date.now(),
        }, { merge: true });
        done++;
        if (done % 10 === 0) setProgress(Math.round((done / preview.length) * 100));
      }
      setProgress(100);
      setMsg(`✓ Imported ${done} patients successfully.`);
      setPreview(null);
    } catch (e) {
      setMsg(`Import failed after ${done} records: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div className="card">
        <h2 className="card-title">Import Patient Records</h2>
        <p className="dim" style={{ fontSize: "0.83rem", marginBottom: "1rem" }}>
          Upload an Excel (.xlsx) or CSV file. Columns matched: <strong>NID</strong> (ID), <strong>Patient Name</strong>, <strong>Age</strong>, <strong>Sex</strong>, plus optional Mobile, Address, Notes. Existing records are updated (merge), not overwritten.
        </p>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
          onChange={(e) => parseFile(e.target.files?.[0])} />
        <button className="btn btn-blue" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "Reading…" : "Choose file"}
        </button>
        {progress !== null && progress < 100 && (
          <div style={{ marginTop: "0.75rem" }}>
            <div style={{ background: "var(--border)", borderRadius: "100px", height: "6px", overflow: "hidden" }}>
              <div style={{ background: "var(--blue)", height: "100%", width: `${progress}%`, transition: "width 0.3s", borderRadius: "100px" }} />
            </div>
            <div className="dim" style={{ fontSize: "0.78rem", marginTop: "0.3rem" }}>Importing… {progress}%</div>
          </div>
        )}
        {msg && <div style={{ fontSize: "0.83rem", marginTop: "0.75rem", color: msg.startsWith("✓") ? "var(--green)" : "var(--red)" }}>{msg}</div>}
      </div>

      {preview && (
        <div className="card" style={{ borderColor: "var(--blue)" }}>
          <h2 className="card-title">Preview — {preview.length} patients found</h2>
          <div className="table-wrap" style={{ maxHeight: "350px", overflowY: "auto" }}>
            <table className="data-table">
              <thead><tr><th>NID</th><th>Name</th><th>Age</th><th>Sex</th></tr></thead>
              <tbody>
                {preview.map((p, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ fontSize: "0.8rem" }}>{p.idNumber}</td>
                    <td>{p.name}</td>
                    <td>{p.age || "—"}</td>
                    <td>{p.sex || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", alignItems: "center" }}>
            <button className="btn btn-green" onClick={confirmImport} disabled={busy}>
              {busy ? "Importing…" : `Import ${preview.length} patients`}
            </button>
            <button className="btn btn-outline" onClick={() => setPreview(null)} disabled={busy}>Cancel</button>
            <span className="dim" style={{ fontSize: "0.8rem" }}>This may take a moment for large files.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   PATIENT REGISTRATION — Admin / Receptionist
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

  // CSV export helpers
  const downloadCSV = (filename, rows) => {
    const escape = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = rows.map((r) => r.map(escape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportSessions = () => {
    const header = ["Date", "Room", "Doctor", "Department", "Start", "End", "Duration (min)", "Tokens served"];
    const rows = sessions.map((s) => [
      s.date,
      s.room,
      s.doctor,
      s.department || "",
      s.startedAt?.toDate ? s.startedAt.toDate().toLocaleString() : "",
      s.endedAt?.toDate ? s.endedAt.toDate().toLocaleString() : "",
      s.durationMin,
      s.tokensServed,
    ]);
    downloadCSV(`clinicq-sessions_${from}_to_${to}.csv`, [header, ...rows]);
  };

  const exportDoctorSummary = () => {
    const header = ["Doctor", "Sessions", "Tokens served", "Total time (min)", "Avg tokens/session"];
    const rows = Object.entries(byDoctor)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([name, d]) => [name, d.sessions, d.tokens, d.duration, Math.round(d.tokens / d.sessions)]);
    downloadCSV(`clinicq-doctor-summary_${from}_to_${to}.csv`, [header, ...rows]);
  };

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
          <div style={{ flex: 1 }} />
          <button className="btn btn-outline" style={{ marginTop: "1rem" }} onClick={exportSessions} disabled={sessions.length === 0}>
            ⬇ Sessions CSV
          </button>
          <button className="btn btn-outline" style={{ marginTop: "1rem" }} onClick={exportDoctorSummary} disabled={sessions.length === 0}>
            ⬇ Doctor summary CSV
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

/* LOBBY — dark + light theme */
/* Dark theme (default) */
.lobby { min-height: 100vh; padding: 1.25rem 1.5rem 0; display: flex; flex-direction: column; }
.lobby-dark { background: #060810; color: #fff; }
.lobby-light { background: #f0f4f8; color: #0f172a; }

/* Top bar: logo + controls */
.lobby-topbar {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 1.25rem; padding-bottom: 1rem;
}
.lobby-dark .lobby-topbar { border-bottom: 1px solid #ffffff10; }
.lobby-light .lobby-topbar { border-bottom: 1px solid #cbd5e1; }

/* Theme toggle */
.lobby-theme-btn {
  background: transparent; border: none; cursor: pointer;
  font-size: 1.3rem; padding: 0.25rem 0.5rem; border-radius: 8px; transition: background 0.15s;
}
.lobby-dark .lobby-theme-btn { color: #fff; }
.lobby-dark .lobby-theme-btn:hover { background: #ffffff18; }
.lobby-light .lobby-theme-btn { color: #0f172a; }
.lobby-light .lobby-theme-btn:hover { background: #00000010; }

/* Loading / empty */
.lobby-loading, .lobby-empty { flex: 1; text-align: center; padding: 6rem; opacity: 0.3; display: flex; align-items: center; justify-content: center; gap: 1rem; font-size: 1.1rem; }
.lobby-dark .spinner { border: 2px solid #ffffff22; border-top-color: #fff; }
.lobby-light .spinner { border: 2px solid #00000022; border-top-color: #0f172a; }
.spinner { width: 24px; height: 24px; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Grid */
.lobby-grid { display: grid; gap: 1.25rem; flex: 1; align-content: start; }
/* Use a consistent 4-column reference width regardless of room count,
   so a single room's card matches the size it would be in a full grid,
   and stays left-aligned rather than centered/stretched. */
.lobby-grid-1, .lobby-grid-2, .lobby-grid-3, .lobby-grid-4 { grid-template-columns: repeat(4, 1fr); }
.lobby-grid-1 > *, .lobby-grid-2 > *, .lobby-grid-3 > * { grid-column: span 1; }
@media (max-width: 900px) {
  .lobby-grid-1, .lobby-grid-2, .lobby-grid-3, .lobby-grid-4 { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 600px) {
  .lobby { padding: 1rem 1rem 0; }
  .lobby-grid, .lobby-grid-1, .lobby-grid-2, .lobby-grid-3, .lobby-grid-4 { grid-template-columns: 1fr; max-width: 100%; }
  .lobby-logo-img { max-height: 40px; max-width: 140px; }
  .lobby-logo-text { font-size: 1rem; }
  .lobby-room-id { font-size: 1.3rem; }
  .lobby-doctor-name { font-size: 1.3rem; }
  .lobby-token-num { font-size: 3rem; }
  .lobby-token-next { font-size: 2rem !important; }
}

/* Cards */
.lobby-card {
  border-radius: 20px; padding: 1.5rem 1.75rem; position: relative; overflow: hidden;
  transition: background 0.3s, border-color 0.3s;
}
.lobby-card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
  background: var(--accent, #334155); border-radius: 20px 20px 0 0;
}
.lobby-dark .lobby-card { background: #0d1119; border: 1px solid var(--accent, #ffffff12); }
.lobby-light .lobby-card { background: #fff; border: 1px solid var(--accent, #e2e8f0); box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
.lobby-card-flash { animation: cardFlash 1.2s ease-out; }
@keyframes cardFlash {
  0%   { background: #1a2a1a; border-color: #22c55e; }
  40%  { background: #111d11; border-color: #22c55e88; }
  100% { border-color: var(--accent, #ffffff12); }
}
.lobby-light .lobby-card-flash { animation: cardFlashLight 1.2s ease-out; }
@keyframes cardFlashLight {
  0%   { background: #dcfce7; border-color: #22c55e; }
  100% { background: #fff; border-color: var(--accent, #e2e8f0); }
}
.lobby-card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; }
.lobby-room-id { font-family: 'Space Grotesk', sans-serif; font-size: 1.4rem; font-weight: 700; letter-spacing: -0.01em; }
.lobby-status-badge { font-size: 0.7rem; font-weight: 700; padding: 3px 10px; border-radius: 100px; letter-spacing: 0.05em; }
.lobby-doctor-name { font-size: 1.5rem; font-weight: 700; margin-bottom: 2px; line-height: 1.2; }
.lobby-dark .lobby-doctor-name { color: #fff; }
.lobby-light .lobby-doctor-name { color: #0f172a; }
.lobby-dept { font-size: 0.8rem; opacity: 0.45; margin-bottom: 1.25rem; }

/* Token row */
.lobby-token-row { display: flex; align-items: stretch; gap: 1rem; }
.lobby-token-block { flex: 1; }
.lobby-dark .lobby-divider { width: 1px; background: #ffffff0f; flex-shrink: 0; }
.lobby-light .lobby-divider { width: 1px; background: #00000010; flex-shrink: 0; }
.lobby-divider { flex-shrink: 0; width: 1px; }
.lobby-token-label { font-size: 0.6rem; letter-spacing: 0.12em; opacity: 0.4; margin-bottom: 0.4rem; font-weight: 700; text-transform: uppercase; }
.lobby-token-num { font-family: 'Space Grotesk', sans-serif; font-size: 4.5rem; font-weight: 700; line-height: 1; }
.lobby-token-animate { animation: tokenPop 0.5s cubic-bezier(0.34,1.56,0.64,1); }
@keyframes tokenPop {
  0%   { transform: scale(0.7); opacity: 0.3; color: #22c55e; }
  60%  { transform: scale(1.15); }
  100% { transform: scale(1); opacity: 1; }
}
.lobby-token-next { font-size: 2.5rem !important; opacity: 0.45; }

/* Wait estimate */
.lobby-wait-estimate {
  margin-top: 0.75rem; font-size: 0.82rem; font-weight: 500; opacity: 0.6;
  letter-spacing: 0.02em;
}

/* Break box */
.lobby-break-box { display: flex; flex-direction: column; align-items: center; padding: 1.5rem 0; gap: 0.4rem; }
.lobby-break-icon { font-size: 2rem; }
.lobby-break-text { font-size: 1.1rem; font-weight: 600; opacity: 0.8; }
.lobby-break-return { font-size: 0.9rem; opacity: 0.55; }

/* Logo */
.lobby-logo-wrap { display: flex; align-items: center; }
.lobby-logo-img { max-height: 52px; max-width: 200px; object-fit: contain; }
.lobby-dark .lobby-logo-img { filter: brightness(1.1); }
.lobby-logo-text { font-family: 'Space Grotesk', sans-serif; font-size: 1.3rem; font-weight: 700; letter-spacing: -0.02em; }

/* Bottom bar: clock + QR */
.lobby-bottombar {
  display: flex; justify-content: space-between; align-items: flex-end;
  padding: 1rem 0 1.25rem; margin-top: 1.25rem;
}
.lobby-dark .lobby-bottombar { border-top: 1px solid #ffffff10; }
.lobby-light .lobby-bottombar { border-top: 1px solid #cbd5e1; }
.lobby-clock-bottom { }
.lobby-time { font-family: 'JetBrains Mono', monospace; font-size: 1.6rem; font-weight: 500; letter-spacing: 0.06em; }
.lobby-date { font-size: 0.75rem; opacity: 0.4; margin-top: 2px; }
.lobby-qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.lobby-qr-label { font-size: 0.6rem; opacity: 0.35; letter-spacing: 0.06em; text-transform: uppercase; }

@keyframes pulse {
  0%,100% { box-shadow: 0 0 0 0 #22c55e88; }
  50% { box-shadow: 0 0 0 10px transparent; }
}
.lobby-pulse {
  display: inline-block; width: 10px; height: 10px; border-radius: 50%;
  background: #22c55e; box-shadow: 0 0 0 0 #22c55e88;
  animation: pulse 1.8s ease-in-out infinite;
}

/* CONNECTION INDICATOR */
.offline-banner {
  position: sticky; top: 0; z-index: 50;
  background: #dc2626; color: #fff;
  text-align: center; padding: 0.6rem 1rem;
  font-size: 0.95rem; font-weight: 600; letter-spacing: 0.01em;
  display: flex; align-items: center; justify-content: center; gap: 0.6rem;
  margin: -1.5rem -1.5rem 1.25rem;
  animation: bannerSlide 0.3s ease-out;
}
@keyframes bannerSlide { from { transform: translateY(-100%); } to { transform: translateY(0); } }
.offline-dot {
  width: 9px; height: 9px; border-radius: 50%; background: #fff;
  animation: blink 1s ease-in-out infinite;
}
@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.conn-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.conn-online { background: #22c55e; box-shadow: 0 0 6px #22c55e88; }
.conn-offline { background: #dc2626; box-shadow: 0 0 6px #dc2626; animation: blink 1s ease-in-out infinite; }

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
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 1rem; }
.modal-card { background: var(--surface); border-radius: var(--radius); padding: 1.5rem; width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0,0,0,0.25); }
.btn-google { background: var(--surface); color: var(--text); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; }
.btn-google:hover { background: #f9fafb; }
.login-divider { display: flex; align-items: center; gap: 0.75rem; margin: 1rem 0; color: var(--text-dim); font-size: 0.8rem; }
.login-divider::before, .login-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
`;
