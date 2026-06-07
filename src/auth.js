/**
 * auth.js — ClinicQ authentication
 *
 * DEVELOPER  → Google Sign-In (only your email allowed)
 * SUPERADMIN → username + password → Firebase Auth email account
 * ADMIN      → username + password → Firebase Auth email account
 * DOCTOR     → username + password → Firebase Auth email account (per room)
 *
 * Firebase Auth emails:
 *   superadmin → superadmin@clinicq.local
 *   admin      → admin@clinicq.local
 *   room R01   → r01@clinicq.local
 */

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  updatePassword,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db, googleProvider, DEVELOPER_EMAIL } from "./firebase.js";

const CREDS_DOC = doc(db, "clinicq", "credentials");

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function roleToEmail(role, room = null) {
  if (role === "SUPERADMIN") return "superadmin@clinicq.local";
  if (role === "ADMIN")      return "admin@clinicq.local";
  if (role === "DOCTOR" && room) return `${room.toLowerCase()}@clinicq.local`;
  throw new Error("Cannot determine auth email for role: " + role);
}

export function emailToRole(email) {
  if (!email) return { role: null, room: null };
  if (DEVELOPER_EMAIL && email === DEVELOPER_EMAIL) return { role: "DEVELOPER", room: null };
  if (email === "superadmin@clinicq.local") return { role: "SUPERADMIN", room: null };
  if (email === "admin@clinicq.local")      return { role: "ADMIN", room: null };
  const m = email.match(/^([a-z0-9]+)@clinicq\.local$/);
  if (m) return { role: "DOCTOR", room: m[1].toUpperCase() };
  return { role: null, room: null };
}

/* ─────────────────────────────────────────────
   AUTH STATE OBSERVER
───────────────────────────────────────────── */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, (user) => {
    if (user) {
      const { role, room } = emailToRole(user.email);
      callback({ user, role, room });
    } else {
      callback({ user: null, role: null, room: null });
    }
  });
}

/* ─────────────────────────────────────────────
   GOOGLE SIGN-IN (Developer only)
   Tries popup; falls back to redirect if COOP blocks it.
───────────────────────────────────────────── */
export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return _validateDeveloper(result.user);
  } catch (e) {
    // Popup blocked (COOP / popup-blocked / closed) → use redirect flow
    if (
      e.code === "auth/popup-blocked" ||
      e.code === "auth/popup-closed-by-user" ||
      e.code === "auth/cancelled-popup-request" ||
      e.message?.includes("Cross-Origin-Opener-Policy")
    ) {
      await signInWithRedirect(auth, googleProvider);
      return { success: true, redirecting: true };
    }
    return { success: false, error: e.message };
  }
}

// Called on app load to complete a redirect-based sign-in
export async function completeGoogleRedirect() {
  try {
    const result = await getRedirectResult(auth);
    if (result?.user) return _validateDeveloper(result.user);
    return { success: false, noRedirect: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function _validateDeveloper(user) {
  if (!DEVELOPER_EMAIL) {
    await signOut(auth);
    return { success: false, error: "Developer email not configured. Set VITE_DEVELOPER_EMAIL." };
  }
  if (user.email !== DEVELOPER_EMAIL) {
    await signOut(auth);
    return { success: false, error: `Access denied. Only ${DEVELOPER_EMAIL} can sign in as Developer.` };
  }
  return { success: true };
}

/* ─────────────────────────────────────────────
   LOGOUT
───────────────────────────────────────────── */
export async function logout() {
  await signOut(auth);
}

/* ─────────────────────────────────────────────
   FETCH CREDENTIALS
───────────────────────────────────────────── */
export async function fetchCredentials() {
  const snap = await getDoc(CREDS_DOC);
  return snap.exists() ? snap.data() : null;
}

/* ─────────────────────────────────────────────
   FIRST-RUN SETUP
───────────────────────────────────────────── */
export async function initCredentials(rooms) {
  const snap = await getDoc(CREDS_DOC);
  if (snap.exists()) {
    const creds = snap.data();
    for (const id of rooms) {
      if (!creds.rooms?.[id]) {
        await _createAuthAccount(`${id.toLowerCase()}@clinicq.local`, `room_${id.toLowerCase()}`);
        await _addRoomToCredDoc(id, creds);
      }
    }
    return;
  }
  const [saHash, adHash] = await Promise.all([sha256("root00"), sha256("admin1")]);
  const roomEntries = await Promise.all(
    rooms.map(async (id) => {
      const p = `room_${id.toLowerCase()}`;
      return [id, { username: `room_${id.toLowerCase()}`, passwordHash: await sha256(p) }];
    })
  );
  await setDoc(CREDS_DOC, {
    superadmin: { username: "root",  passwordHash: saHash  },
    admin:      { username: "admin", passwordHash: adHash  },
    rooms:      Object.fromEntries(roomEntries),
  });
  await _createAuthAccount("superadmin@clinicq.local", "root00");
  await _createAuthAccount("admin@clinicq.local",      "admin1");
  for (const id of rooms) {
    await _createAuthAccount(`${id.toLowerCase()}@clinicq.local`, `room_${id.toLowerCase()}`);
  }
}

async function _createAuthAccount(email, password) {
  try {
    await createUserWithEmailAndPassword(auth, email, password);
    await signOut(auth);
  } catch (e) {
    if (e.code !== "auth/email-already-in-use") console.warn("Auth account:", e.message);
  }
}

async function _addRoomToCredDoc(roomId, existingCreds) {
  const p = `room_${roomId.toLowerCase()}`;
  await setDoc(CREDS_DOC, {
    ...existingCreds,
    rooms: {
      ...(existingCreds.rooms || {}),
      [roomId]: { username: `room_${roomId.toLowerCase()}`, passwordHash: await sha256(p) },
    },
  });
}

/* ─────────────────────────────────────────────
   LOGIN (username + password roles)
───────────────────────────────────────────── */
export async function verifyLogin(role, username, password, room = null) {
  const creds = await fetchCredentials();
  if (!creds) throw new Error("System not initialised. Please wait and try again.");

  const hash = await sha256(password);
  let match = false;

  if (role === "SUPERADMIN") {
    match = creds.superadmin?.username === username && creds.superadmin?.passwordHash === hash;
  } else if (role === "ADMIN") {
    match = creds.admin?.username === username && creds.admin?.passwordHash === hash;
  } else if (role === "DOCTOR") {
    if (!room) return { success: false, error: "No room selected." };
    const rc = creds.rooms?.[room];
    match = rc?.username === username && rc?.passwordHash === hash;
  }

  if (!match) return { success: false, error: "Invalid username or password." };

  try {
    const email = roleToEmail(role, room);
    await signInWithEmailAndPassword(auth, email, password);
    return { success: true };
  } catch (e) {
    if (e.code === "auth/user-not-found" || e.code === "auth/invalid-credential") {
      await _createAuthAccount(roleToEmail(role, room), password);
      try {
        await signInWithEmailAndPassword(auth, roleToEmail(role, room), password);
        return { success: true };
      } catch (e2) {
        return { success: false, error: "Auth account mismatch. Contact your administrator." };
      }
    }
    return { success: false, error: "Authentication failed: " + e.message };
  }
}

/* ─────────────────────────────────────────────
   CHANGE PASSWORD (Developer portal)
───────────────────────────────────────────── */
export async function changePassword(role, newUsername, newPassword, room = null) {
  if (newPassword.length < 6) throw new Error("Password must be at least 6 characters.");
  const snap = await getDoc(CREDS_DOC);
  const creds = snap.exists() ? snap.data() : {};
  const hash = await sha256(newPassword);

  if (role === "SUPERADMIN") {
    await setDoc(CREDS_DOC, { ...creds, superadmin: { username: newUsername, passwordHash: hash } });
  } else if (role === "ADMIN") {
    await setDoc(CREDS_DOC, { ...creds, admin: { username: newUsername, passwordHash: hash } });
  } else if (role === "DOCTOR" && room) {
    await setDoc(CREDS_DOC, {
      ...creds,
      rooms: { ...(creds.rooms || {}), [room]: { username: newUsername, passwordHash: hash } },
    });
  }

  // Update Firebase Auth password if currently signed in as that account
  try {
    const email = roleToEmail(role, room);
    if (auth.currentUser?.email === email) {
      await updatePassword(auth.currentUser, newPassword);
    }
  } catch (e) {
    console.warn("Firebase Auth password update:", e.message);
  }
}

/* ─────────────────────────────────────────────
   ADD / REMOVE ROOM
───────────────────────────────────────────── */
export async function addRoomCredential(roomId) {
  const snap = await getDoc(CREDS_DOC);
  const creds = snap.exists() ? snap.data() : {};
  const p = `room_${roomId.toLowerCase()}`;
  await setDoc(CREDS_DOC, {
    ...creds,
    rooms: { ...(creds.rooms || {}), [roomId]: { username: `room_${roomId.toLowerCase()}`, passwordHash: await sha256(p) } },
  });
  await _createAuthAccount(`${roomId.toLowerCase()}@clinicq.local`, p);
}

export async function removeRoomCredential(roomId) {
  const snap = await getDoc(CREDS_DOC);
  const creds = snap.exists() ? snap.data() : {};
  const rooms = { ...(creds.rooms || {}) };
  delete rooms[roomId];
  await setDoc(CREDS_DOC, { ...creds, rooms });
}