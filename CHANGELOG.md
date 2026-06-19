# ClinicQ Changelog
Noosandha Clinic — Queue Management System

---

## v2.0.0 — June 2026
**Initial production build**

### Architecture
- Split into two separate entry points: `/` (lobby TV) and `/login` (staff portal)
- Lobby loads fast with no staff code bundled
- Single login page for all staff — Doctor, Receptionist, Admin, Developer
- Logout always returns to `/login`
- Token tracker at `/#track` on lobby domain for patient QR scanning

### Staff Directory
- Permanent staff record independent of login/operational status
- Categories: Doctor / Nurse / Receptionist / Admin Staff / Other
- Filter bar: All / Doctors / Nurses / Reception / Admin Staff / Other / Has login / No login
- Active/Inactive toggle — separate from login access
- `rebuildDoctorDirectory` now driven by `category === "doctor"` not login role
- Revoking login no longer removes doctor from room assignment dropdowns
- One-time migration: orphaned doctorDirectory entries merged into staff list

### Booking & Reception
- Patient category field: General / Police / Police EXO / Police Family / Emergency / Police Custody
- Police service number (4-digit) — shown for police categories only
- Consultation type: Walk-in / Online
- Follow-up flag with "last visit X days ago" hint
- Search bar replaces old "Change" button — always active
- Edit patient details inline from booking screen
- Clear all room assignments button
- Room display shows live assignment when visit has no stored room

### Doctor Portal
- Auto room detection via email matching — no room picker shown
- "No room assigned yet" message when not assigned
- Patient list queries by `doctorId` + `doctorName` fallback
- Missed token — "⊘ No Show" button marks patient missed, advances queue
- "↻ Call again" for missed patients via custom call
- Badges: patient category, follow-up, consultation type, police service number
- "Now Serving" card shows patient name, ID, category badges prominently
- Dark / Light theme toggle saved to localStorage per device
- Start session begins at lowest waiting token for today
- Next button auto-marks previous patient as served

### Lobby
- Dark / Light theme toggle (Admin controlled via Firestore)
- Room cards maintain consistent proportion regardless of room count — left aligned
- QR code theme-aware (black on light, white on dark)
- Personal token tracker resolves room dynamically if empty at booking time

### Security
- Session persistence: auth token clears on browser/tab close
- Staff whitelist check: email must exist in `clinicq/staff` to gain access
- Firestore security rules deployed
- Composite indexes deployed
- Legacy room credential system (`@clinicq.local`) fully removed
- `window.prompt()` replaced with inline React UI throughout
- Admin can manage staff roles via Cloud Function (no longer Developer-only)

### Email
- Branded Resend email for staff onboarding — shows email address, role, login URL
- Password reset link embedded in email (1 hour validity)
- Firebase `actionCodeSettings` with login URL on all reset emails

### Code Quality
- Dead code removed: `AdminLoginPage`, `PatientRegistration`, `CredCard`, `CredentialsTab`, `TokenTracker` (moved to lobby)
- `auth.js` trimmed from 311 → 150 lines
- Legacy functions removed: `fetchCredentials`, `changePassword`, `initCredentials`, `addRoomCredential`, `removeRoomCredential`
- QR library moved from CDN (`esm.sh`) to npm dependency
- Orphaned files removed: `reception_new.jsx`, `AdminPortal.jsx`
- Silent `catch {}` blocks replaced with `console.warn` or visible error feedback

---

## Upcoming — Next Build

### Planned features
- [ ] Firebase Hosting deployment
- [ ] Resend email domain verification (custom from address)
- [ ] Firebase Console email template for password reset
- [ ] Patient import — full 10-year historical data
- [ ] Analytics improvements
- [ ] Print slip enhancements

### Known items to revisit
- [ ] Session timeout for shared computers (deferred — too disruptive for Reception)
- [ ] Vercel deployment option (if needed alongside Firebase Hosting)

---

*Maintained by: Noosandha Clinic Developer*
*System: ClinicQ v2.0.0 | Firebase (Firestore, Auth, Functions, Hosting) | React + Vite*
