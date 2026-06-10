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
  const m = email.match(/^([a-z0-9]+)@clinicq\.local$/);
  if (m) return { role: "DOCTOR", room: m[1].toUpperCase() };
  return { role: null, room: null };
}

/* ─────────────────────────────────────────────
   AUTH STATE OBSERVER
   Prefers the custom-claim role (set by Cloud Function for
   personal staff accounts); falls back to the email pattern
   for the legacy room/system accounts and the developer.
───────────────────────────────────────────── */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      callback({ user: null, role: null, room: null });
      return;
    }
    // Developer is always recognized by email
    if (DEVELOPER_EMAIL && user.email === DEVELOPER_EMAIL) {
      callback({ user, role: "DEVELOPER", room: null });
      return;
    }
    // Check if this Google account is in the adminEmails whitelist
    try {
      const configSnap = await getDoc(doc(db, "clinicq", "config"));
      if (configSnap.exists()) {
        const adminEmails = configSnap.data().adminEmails || [];
        if (adminEmails.includes(user.email?.toLowerCase())) {
          callback({ user, role: "ADMIN", room: null });
          return;
        }
      }
    } catch {}
    // Personal staff accounts carry their role as a custom claim
    try {
      const token = await user.getIdTokenResult();
      const claimRole = token.claims?.role || null;
      if (claimRole) {
        callback({ user, role: claimRole, room: null });
        return;
      }
    } catch {}
    // Fallback: legacy email-pattern accounts (room logins, etc.)
    const { role, room } = emailToRole(user.email);
    callback({ user, role, room });
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
  // Create the account on a SECONDARY Firebase app instance so we don't
  // disturb the currently signed-in user (e.g. the Developer running setup).
  const { initializeApp, deleteApp } = await import("firebase/app");
  const { getAuth: getSecondaryAuth, createUserWithEmailAndPassword: createOnSecondary, signOut: signOutSecondary } = await import("firebase/auth");
  const { firebaseConfig } = await import("./firebase.js");
  let secondaryApp;
  try {
    secondaryApp = initializeApp(firebaseConfig, "secondary-" + Date.now());
    const secondaryAuth = getSecondaryAuth(secondaryApp);
    await createOnSecondary(secondaryAuth, email, password);
    await signOutSecondary(secondaryAuth);
  } catch (e) {
    if (e.code !== "auth/email-already-in-use") console.warn("Auth account:", e.message);
  } finally {
    if (secondaryApp) { try { await deleteApp(secondaryApp); } catch {} }
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
   Firebase Auth is the source of truth for the password.
   We authenticate FIRST (works without Firestore access),
   then the creds doc is readable because we're now signed in.
───────────────────────────────────────────── */
export async function verifyLogin(role, username, password, room = null) {
  let email;
  try {
    email = roleToEmail(role, room);
  } catch (e) {
    return { success: false, error: e.message };
  }
  if (role === "DOCTOR" && !room) {
    return { success: false, error: "No room selected." };
  }

  try {
    await signInWithEmailAndPassword(auth, email, password);
    return { success: true };
  } catch (e) {
    if (e.code === "auth/invalid-credential" ||
        e.code === "auth/wrong-password" ||
        e.code === "auth/user-not-found") {
      return { success: false, error: "Invalid username or password." };
    }
    if (e.code === "auth/too-many-requests") {
      return { success: false, error: "Too many attempts. Please wait a moment and try again." };
    }
    return { success: false, error: "Sign-in failed: " + e.message };
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