/**
 * ClinicQ Cloud Functions — staff account management
 *
 * All callable functions verify the caller is the Developer
 * (matching DEVELOPER_EMAIL) before doing anything.
 *
 * Roles are stored as Firebase Auth custom claims: { role, room? }
 * so Firestore security rules can check request.auth.token.role.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();

setGlobalOptions({ region: "us-central1", maxInstances: 5 });

// Developer email comes from functions/.env at deploy time.
// "public" invoker lets the callable request reach the code;
// assertDeveloper() below still enforces who can actually act.
const DEVELOPER_EMAIL = process.env.DEVELOPER_EMAIL || "";

const VALID_ROLES = ["DOCTOR", "RECEPTIONIST", "ADMIN", "SUPERADMIN"];

// Guard: only the developer may call these functions
function assertDeveloper(request) {
  const email = request.auth?.token?.email;
  if (!request.auth || !email) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  if (!DEVELOPER_EMAIL || email !== DEVELOPER_EMAIL) {
    throw new HttpsError("permission-denied", "Only the developer can manage staff accounts.");
  }
}

/**
 * Create (or update) a staff account and assign a role.
 * Sends a password-setup email so the person sets their own password.
 * data: { email, name, role }
 */
exports.createStaffAccount = onCall({ invoker: "public" }, async (request) => {
  assertDeveloper(request);
  const { email, name, role } = request.data || {};

  if (!email || !role) throw new HttpsError("invalid-argument", "Email and role are required.");
  if (!VALID_ROLES.includes(role)) throw new HttpsError("invalid-argument", "Invalid role: " + role);

  let user;
  try {
    // Reuse existing account if present, else create one with a random temp password
    try {
      user = await admin.auth().getUserByEmail(email);
    } catch {
      user = await admin.auth().createUser({
        email,
        emailVerified: false,
        displayName: name || undefined,
        password: Math.random().toString(36).slice(2) + "Aa1!", // temp, replaced via reset link
      });
    }

    // Set the role (and clear any room until Admin assigns one)
    await admin.auth().setCustomUserClaims(user.uid, { role });

    // Generate a password-reset link the person uses to set their password
    const link = await admin.auth().generatePasswordResetLink(email);

    return { success: true, uid: user.uid, resetLink: link };
  } catch (e) {
    throw new HttpsError("internal", e.message);
  }
});

/**
 * Change an existing account's role.
 * data: { email, role }
 */
exports.setStaffRole = onCall({ invoker: "public" }, async (request) => {
  assertDeveloper(request);
  const { email, role } = request.data || {};
  if (!email || !role) throw new HttpsError("invalid-argument", "Email and role are required.");
  if (!VALID_ROLES.includes(role)) throw new HttpsError("invalid-argument", "Invalid role.");

  try {
    const user = await admin.auth().getUserByEmail(email);
    const existing = (await admin.auth().getUser(user.uid)).customClaims || {};
    await admin.auth().setCustomUserClaims(user.uid, { ...existing, role });
    return { success: true };
  } catch (e) {
    throw new HttpsError("internal", e.message);
  }
});

/**
 * Revoke an account — removes role claim and disables the user.
 * data: { email }
 */
exports.revokeStaffAccount = onCall({ invoker: "public" }, async (request) => {
  assertDeveloper(request);
  const { email } = request.data || {};
  if (!email) throw new HttpsError("invalid-argument", "Email is required.");

  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { role: null });
    await admin.auth().updateUser(user.uid, { disabled: true });
    await admin.auth().revokeRefreshTokens(user.uid);
    return { success: true };
  } catch (e) {
    throw new HttpsError("internal", e.message);
  }
});

/**
 * Re-enable a previously revoked account.
 * data: { email, role }
 */
exports.reactivateStaffAccount = onCall({ invoker: "public" }, async (request) => {
  assertDeveloper(request);
  const { email, role } = request.data || {};
  if (!email) throw new HttpsError("invalid-argument", "Email is required.");

  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(user.uid, { disabled: false });
    if (role && VALID_ROLES.includes(role)) {
      await admin.auth().setCustomUserClaims(user.uid, { role });
    }
    return { success: true };
  } catch (e) {
    throw new HttpsError("internal", e.message);
  }
});