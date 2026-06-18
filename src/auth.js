/**
 * auth.js — ClinicQ authentication
 *
 * DEVELOPER  → Google Sign-In (only your email allowed)
 * ADMIN      → username + password → Firebase Auth email account
 * DOCTOR     → username + password → Firebase Auth email account (per room)
 *
 * Firebase Auth emails:
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
import { doc, getDoc } from "firebase/firestore";
import { auth, db, googleProvider, DEVELOPER_EMAIL } from "./firebase.js";


/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

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
        if (adminEmails.map(e => e.toLowerCase()).includes(user.email?.toLowerCase())) {
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
  // Developer always allowed
  if (user.email === DEVELOPER_EMAIL) {
    return { success: true };
  }
  // Check if email is in the Admin whitelist
  try {
    const configSnap = await getDoc(doc(db, "clinicq", "config"));
    if (configSnap.exists()) {
      const adminEmails = configSnap.data().adminEmails || [];
      if (adminEmails.map(e => e.toLowerCase()).includes(user.email?.toLowerCase())) {
        return { success: true };
      }
    }
  } catch {}
  // Not Developer or Admin — reject
  await signOut(auth);
  return { success: false, error: "Access denied. Your account is not authorised as Developer or Admin." };
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
