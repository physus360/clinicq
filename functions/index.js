/**
 * ClinicQ Cloud Functions — staff account management
 *
 * All callable functions verify the caller is the Developer
 * (matching DEVELOPER_EMAIL) OR a whitelisted Admin email
 * before doing anything.
 *
 * Roles are stored as Firebase Auth custom claims: { role, room? }
 * so Firestore security rules can check request.auth.token.role.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

setGlobalOptions({ region: "us-central1", maxInstances: 5 });

// Secrets
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// Developer email comes from functions/.env at deploy time.
// "public" invoker lets the callable request reach the code;
// assertDeveloperOrAdmin() below still enforces who can actually act.
const DEVELOPER_EMAIL = process.env.DEVELOPER_EMAIL || "";

const VALID_ROLES = ["DOCTOR", "RECEPTIONIST", "ADMIN"];

// Guard: Developer OR whitelisted Admin may call these functions
async function assertDeveloperOrAdmin(request) {
  const email = request.auth?.token?.email;
  if (!request.auth || !email) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  // Developer always allowed
  if (DEVELOPER_EMAIL && email === DEVELOPER_EMAIL) return;
  // Check Firestore Admin whitelist
  try {
    const snap = await admin.firestore().doc("clinicq/config").get();
    const adminEmails = (snap.exists ? snap.data()?.adminEmails || [] : [])
      .map((e) => e.toLowerCase());
    if (adminEmails.includes(email.toLowerCase())) return;
  } catch {}
  throw new HttpsError("permission-denied", "Only the Developer or an Admin can manage staff accounts.");
}

/**
 * Create (or update) a staff account and assign a role.
 * Sends a password-setup email so the person sets their own password.
 * data: { email, name, role }
 */
exports.createStaffAccount = onCall({ invoker: "public" }, async (request) => {
  await assertDeveloperOrAdmin(request);
  const { email, name, role } = request.data || {};

  if (!email || !role) throw new HttpsError("invalid-argument", "Email and role are required.");
  if (!VALID_ROLES.includes(role)) throw new HttpsError("invalid-argument", "Invalid role: " + role);

  let user;
  try {
    // Reuse existing account if present, else create one with a random temp password
    try {
      user = await admin.auth().getUserByEmail(email);
      // Re-enable if previously disabled and reset password to invalidate old reset links
      if (user.disabled) {
        await admin.auth().updateUser(user.uid, {
          disabled: false,
          displayName: name || user.displayName,
          password: Math.random().toString(36).slice(2) + "Aa1!",
        });
      }
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

    // Note: the password-setup email is sent client-side via
    // sendPasswordResetEmail(), which uses Firebase's built-in email service.
    return { success: true, uid: user.uid };
  } catch (e) {
    throw new HttpsError("internal", e.message);
  }
});

/**
 * Change an existing account's role.
 * data: { email, role }
 */
exports.setStaffRole = onCall({ invoker: "public" }, async (request) => {
  await assertDeveloperOrAdmin(request);
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
  await assertDeveloperOrAdmin(request);
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
  await assertDeveloperOrAdmin(request);
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

/**
 * Send a branded welcome/setup email to a new staff member via Resend.
 * Generates a real Firebase password reset link and embeds it in the email.
 * data: { email, name, role, loginUrl }
 */
exports.sendStaffWelcomeEmail = onCall(
  { invoker: "public", secrets: [RESEND_API_KEY] },
  async (request) => {
    await assertDeveloperOrAdmin(request);
    const { email, name, role, loginUrl } = request.data || {};
    if (!email) throw new HttpsError("invalid-argument", "Email is required.");

    try {
      // Generate a Firebase password reset link (valid for 1 hour)
      const resetLink = await admin.auth().generatePasswordResetLink(email, {
        url: loginUrl || "https://clinicq.web.app/login",
      });

      const roleLabel =
        role === "DOCTOR"       ? "Doctor" :
        role === "RECEPTIONIST" ? "Receptionist" :
        role === "ADMIN"        ? "Admin" : "Staff";

      const firstName = (name || email).split(" ")[0];

      const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:system-ui,-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#1a2235;padding:28px 32px;text-align:center;">
            <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">🏥 Noosandha Clinic</div>
            <div style="font-size:13px;color:#8b96ab;margin-top:4px;">ClinicQ Staff Portal</div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 16px;font-size:15px;color:#14181f;">Hello ${firstName},</p>
            <p style="margin:0 0 16px;font-size:15px;color:#14181f;line-height:1.6;">
              Your staff account has been created on the <strong>Noosandha Clinic ClinicQ</strong> system.
              You have been assigned the role of <strong>${roleLabel}</strong>.
            </p>

            <!-- Login details box -->
            <div style="background:#f4f5f7;border-radius:8px;padding:16px 20px;margin:20px 0;">
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;">Your login details</div>
              <div style="margin-bottom:6px;">
                <span style="font-size:12px;color:#6b7280;width:70px;display:inline-block;">Email</span>
                <span style="font-size:14px;color:#14181f;font-weight:600;">${email}</span>
              </div>
              <div>
                <span style="font-size:12px;color:#6b7280;width:70px;display:inline-block;">Password</span>
                <span style="font-size:14px;color:#14181f;">Set by clicking the button below</span>
              </div>
            </div>

            <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
              Click the button below to set your password. This link is valid for <strong>1 hour</strong>.
              After setting your password, you can sign in at any time using your email address above.
            </p>

            <!-- CTA Button -->
            <div style="text-align:center;margin:28px 0;">
              <a href="${resetLink}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;">
                Set My Password
              </a>
            </div>

            <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.6;">
              After setting your password, sign in at:<br/>
              <a href="${loginUrl || 'https://clinicq.web.app/login'}" style="color:#2563eb;">${loginUrl || 'https://clinicq.web.app/login'}</a>
            </p>

            <hr style="border:none;border-top:1px solid #e2e4e9;margin:24px 0;"/>

            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
              If you did not expect this email, please contact your clinic administrator.<br/>
              This link will expire in 1 hour. If it has expired, ask your administrator to send a new one.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f4f5f7;padding:16px 32px;text-align:center;">
            <div style="font-size:12px;color:#9ca3af;">Noosandha Clinic · ClinicQ Queue Management System</div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

      // Send via Resend
      const resendKey = RESEND_API_KEY.value();
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: "Noosandha Clinic <noreply@resend.dev>",
          to: [email],
          subject: "Your ClinicQ Staff Account — Action Required",
          html: htmlBody,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Resend error: ${err}`);
      }

      return { success: true };
    } catch (e) {
      throw new HttpsError("internal", e.message);
    }
  }
);
