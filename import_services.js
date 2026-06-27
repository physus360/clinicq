// import_services.js
// Run from C:\clinicq: node import_services.js
// Imports clinic and lab services into Supabase

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const SUPABASE_URL  = process.env.VITE_SUPABASE_URL  || "https://pbctjcscvnnhddnxvlfj.supabase.co";
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY; // service key for import

if (!SUPABASE_KEY) {
  console.error("Set SUPABASE_SERVICE_KEY env var before running");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function importServices() {
  // Load JSON files
  const clinicServices = JSON.parse(readFileSync("services_import.json", "utf8"));
  const labServices    = JSON.parse(readFileSync("lab_services_import.json", "utf8"));

  console.log(`Clinic services: ${clinicServices.length}`);
  console.log(`Lab services:    ${labServices.length}`);

  // Format clinic services
  const clinicRows = clinicServices.map(s => ({
    code:               s.code,
    type:               "clinic",
    category:           s.category,
    name:               s.name,
    clinic_price:       s.clinicPrice,
    aasandha_coverage:  s.aasandhaCoverage,
    co_payment:         s.coPayment,
    wp_price:           null,
    tourist_price_usd:  null,
    active:             true,
  }));

  // Format lab services
  const labRows = labServices.map(s => ({
    code:               s.code,
    type:               "lab",
    category:           "LAB",
    name:               s.name,
    clinic_price:       s.clinicPrice,
    aasandha_coverage:  s.aasandhaCoverage,
    co_payment:         s.coPayment,
    wp_price:           s.wpPrice || null,
    tourist_price_usd:  s.touristPriceUSD || null,
    active:             true,
  }));

  const allServices = [...clinicRows, ...labRows];
  console.log(`\nTotal to import: ${allServices.length}`);

  // Import in batches of 100
  const batchSize = 100;
  let imported = 0;
  let errors = 0;

  for (let i = 0; i < allServices.length; i += batchSize) {
    const batch = allServices.slice(i, i + batchSize);
    const { error } = await supabase
      .from("services")
      .upsert(batch, { onConflict: "code" });

    if (error) {
      console.error(`Batch ${Math.floor(i/batchSize)+1} error:`, error.message);
      errors += batch.length;
    } else {
      imported += batch.length;
      process.stdout.write(`\rImported: ${imported}/${allServices.length}`);
    }
  }

  console.log(`\n\nDone!`);
  console.log(`Imported: ${imported}`);
  console.log(`Errors:   ${errors}`);
}

importServices().catch(console.error);
