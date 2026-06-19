/**
 * auth.js — ClinicQ authentication
 *
 * DEVELOPER  → Google Sign-In (only developer email allowed)
 * ADMIN      → Google Sign-In (whitelisted in adminEmails)
 * DOCTOR     → email + password (Firebase Auth, created via Cloud Function)
 * RECEPTIONIST → email + password (Firebase Auth, created via Cloud Function)
 */

import {
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db, googleProvider, DEVELOPER_EMAIL } from "./firebase.js";


/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

export function emailToRole(email) {
  if (!email) return { role: null, room: null };
  if (DEVELOPER_EMAIL && email === DEVELOPER_EMAIL) return { role: "DEVELOPER", room: null };
  // Legacy: old room-based accounts (r01@clinicq.local etc.)
  const m = email.match(/^([a-z0-9]+)@clinicq\.local$/);
  if (m) return { role: "DOCTOR", room: m[1].toUpperCase() };
  return { role: null, room: null };
}

/* ─────────────────────────────────────────────
   AUTH STATE OBSERVER
   Checks role in this order:
   1. Developer email match
   2. Admin whitelist (Firestore config.adminEmails)
   3. Custom claim role (set by Cloud Function for staff accounts)
      + staff directory whitelist check for extra security
   4. Legacy email pattern fallback
───────────────────────────────────────────── */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      callback({ user: null, role: null, room: null });
      return;
    }

    // Developer is always recognized by email — no whitelist check needed
    if (DEVELOPER_EMAIL && user.email === DEVELOPER_EMAIL) {
      callback({ user, role: "DEVELOPER", room: null });
      return;
    }

    // Check if this account is in the adminEmails whitelist
    let isAdmin = false;
    try {
      const configSnap = await getDoc(doc(db, "clinicq", "config"));
      if (configSnap.exists()) {
        const adminEmails = configSnap.data().adminEmails || [];
        if (adminEmails.map(e => e.toLowerCase()).includes(user.email?.toLowerCase())) {
          isAdmin = true;
        }
      }
    } catch {}

    if (isAdmin) {
      callback({ user, role: "ADMIN", room: null });
      return;
    }

    // Personal staff accounts carry their role as a custom claim
    let claimRole = null;
    try {
      const token = await user.getIdTokenResult();
      claimRole = token.claims?.role || null;
    } catch {}

    if (claimRole) {
      // Extra security: verify this email exists in clinicq/staff
      // Prevents anyone with a stale/orphaned Firebase account from accessing
      try {
        const staffSnap = await getDoc(doc(db, "clinicq", "staff"));
        if (staffSnap.exists()) {
          const people = staffSnap.data().people || [];
          const inStaff = people.some(
            (p) => p.email && p.email.toLowerCase() === user.email?.toLowerCase()
          );
          if (!inStaff) {
            // Account exists in Firebase Auth but not in staff directory — reject
            console.warn("Login rejected: email not in staff directory:", user.email);
            await signOut(auth);
            callback({ user: null, role: null, room: null });
            return;
          }
        }
      } catch {
        // If staff check fails (e.g. offline), allow through — don't lock out staff
      }
      callback({ user, role: claimRole, room: null });
      return;
    }

    // Fallback: legacy email-pattern accounts
    const { role, room } = emailToRole(user.email);
    if (role) {
      callback({ user, role, room });
    } else {
      // No role, not in any whitelist — sign out immediately
      console.warn("Login rejected: no role found for", user.email);
      await signOut(auth);
      callback({ user: null, role: null, room: null });
    }
  });
}

/* ─────────────────────────────────────────────
   GOOGLE SIGN-IN (Developer + Admin)
   Tries popup; falls back to redirect if COOP blocks it.
───────────────────────────────────────────── */
export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return _validateDeveloper(result.user);
  } catch (e) {
    if (
      e.code === "auth/popup-blocked" ||
      e.code === "auth/popup-closed-by-user" ||
      e.code === "auth/cancelled-popup-request"
    ) {
      try {
        await signInWithRedirect(auth, googleProvider);
        return { redirecting: true };
      } catch (re) {
        return { success: false, error: re.message };
      }
    }
    return { success: false, error: e.message };
  }
}

export async function completeGoogleRedirect() {
  try {
    const result = await getRedirectResult(auth);
    if (!result) return null;
    return _validateDeveloper(result.user);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/* ─────────────────────────────────────────────
   VALIDATE GOOGLE SIGN-IN
   Allows Developer email and Admin whitelist.
───────────────────────────────────────────── */
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
   EMAIL + PASSWORD SIGN-IN (staff)
───────────────────────────────────────────── */
export async function signInWithEmail(email, password) {
  try {
    await signInWithEmailAndPassword(auth, email.trim(), password);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/* ─────────────────────────────────────────────
   LOGOUT
───────────────────────────────────────────── */
export async function logout() {
  await signOut(auth);
  window.location.href = "/login";
}