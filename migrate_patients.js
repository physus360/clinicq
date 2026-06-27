// migrate_patients.js
// Run from C:\clinicq: node migrate_patients.js

import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
import { readFileSync } from "fs";

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

  if (snap.size === 0) {
    console.log("No patients to migrate.");
    process.exit(0);
  }

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

  console.log(`Valid patients to import: ${patients.length}`);

  const batchSize = 100;
  let imported = 0;
  let errors = 0;

  for (let i = 0; i < patients.length; i += batchSize) {
    const batch = patients.slice(i, i + batchSize);
    const { error } = await supabase
      .from("patients")
      .upsert(batch, { onConflict: "id_number" });

    if (error) {
      console.error(`\nBatch ${Math.floor(i / batchSize) + 1} error:`, error.message);
      errors += batch.length;
    } else {
      imported += batch.length;
      process.stdout.write(`\rImported: ${imported}/${patients.length}`);
    }
  }

  console.log(`\n\nMigration complete!`);
  console.log(`Imported: ${imported}`);
  console.log(`Errors:   ${errors}`);
  console.log(`Skipped:  ${snap.size - patients.length} (incomplete records)`);
  process.exit(0);
}

migratePatients().catch(e => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
