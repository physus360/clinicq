# ClinicQ — Hospital Queue Management System

A real-time clinic queue management app built with React + Firebase Firestore.

## Portals

| Portal | URL | Default Credentials |
|---|---|---|
| Lobby (public display) | `/` or `/#lobby` | No login needed |
| Doctor | `/#doctor` | `room_r01` / `room_r01` |
| Admin | `/#admin` | `admin` / `admin` |
| Super-Admin | `/#superadmin` | `root` / `root` |

---

## 1. Firebase Setup

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → name it (e.g. `clinicq`) → Continue
3. Disable Google Analytics if you don't need it → **Create project**
4. In the left sidebar: **Build → Firestore Database**
5. Click **Create database** → choose **Start in test mode** → select your region → **Enable**
6. Go to **Project Settings** (gear icon) → **Your apps** → click the **</>** web icon
7. Register the app (any nickname) → copy the `firebaseConfig` values

---

## 2. Local Development

### Clone & install
```bash
git clone https://github.com/YOUR_USERNAME/clinicq.git
cd clinicq
npm install
```

### Add environment variables
Create a `.env.local` file in the project root:
```
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
```

### Run
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173)

---

## 3. Deploy to Vercel

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/clinicq.git
git push -u origin main
```

### Step 2 — Import to Vercel
1. Go to [https://vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repo
3. Framework preset will auto-detect **Vite** ✓
4. **Before deploying**, click **Environment Variables** and add all 6 `VITE_FIREBASE_*` keys with their values
5. Click **Deploy**

### Step 3 — Done!
Vercel auto-deploys on every `git push` to `main`.

---

## Firestore Security Rules

For production, replace the test mode rules with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /clinicq/{document} {
      allow read: if true;
      allow write: if true;
    }
    match /clinicq_audit/{document} {
      allow read, write: if true;
    }
  }
}
```

> ⚠️ For a real production deployment, consider adding Firebase Authentication to restrict writes to authenticated users only.

---

## Project Structure

```
clinicq/
├── src/
│   ├── main.jsx        # React entry point
│   ├── App.jsx         # Main app (all portals)
│   └── firebase.js     # Firebase init (reads from env vars)
├── index.html
├── vite.config.js
├── package.json
├── .env.local          # ← your secrets (not committed)
└── .gitignore
```
