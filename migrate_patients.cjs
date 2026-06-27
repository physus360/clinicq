// migrate_patients.cjs
const admin = require("./functions/node_modules/firebase-admin");
const { createClient } = require("@supabase/supabase-js");
const { readFileSync } = require("fs");

const SUPABASE_URL = "https://pbctjcscvnnhddnxvlfj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_KEY) {
  console.error("Set SUPABASE_SERVICE_KEY before running");
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync("serviceAccount.json", "utf8"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function migratePatients() {
  console.log("Reading patients from Firestore...");
  const snap = await db.collection("clinicq_patients").get();
  console.log(`Found ${snap.size} patients`);

  if (snap.size === 0) { console.log("No patients found."); process.exit(0); }

  const patients = snap.docs.map(doc => {
    const d = doc.data();
    return {
      id_number:         (d.idNumber || doc.id || "").trim().toUpperCase(),
      name:              d.name || "",
      dob:               d.dob || null,
      sex:               d.sex || null,
      mobile:            d.mobile || null,
      category:          d.category || "General",
      police_service_no: d.policeServiceNo || null,
      address:           d.address || null,
      notes:             d.notes || null,
      updated_at:        new Date().toISOString(),
    };
  }).filter(p => p.id_number && p.name);

  console.log(`Valid patients: ${patients.length}`);

  let imported = 0, errors = 0;
  for (let i = 0; i < patients.length; i += 100) {
    const batch = patients.slice(i, i + 100);
    const { error } = await supabase.from("patients").upsert(batch, { onConflict: "id_number" });
    if (error) { console.error(`\nBatch error:`, error.message); errors += batch.length; }
    else { imported += batch.length; process.stdout.write(`\rImported: ${imported}/${patients.length}`); }
  }

  console.log(`\n\nDone! Imported: ${imported}, Errors: ${errors}`);
  process.exit(0);
}

migratePatients().catch(e => { console.error("Failed:", e.message); process.exit(1); });
