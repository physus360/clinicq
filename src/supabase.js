// supabase.js — ClinicQ Supabase client
// Handles all billing, patient, memo, and service catalogue data
// Real-time queue stays on Firebase — this is for structured/relational data

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("Supabase env vars missing — check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Clinic helpers ──────────────────────────────────────────
export const CLINIC_CODES = {
  MALE: "MALE",
  DHOO: "DHOO",
  ADDU: "ADDU",
};

// Get clinic UUID by code — cached after first call
const clinicCache = {};
export async function getClinicId(code = "MALE") {
  if (clinicCache[code]) return clinicCache[code];
  const { data, error } = await supabase
    .from("clinics")
    .select("id")
    .eq("code", code)
    .single();
  if (error) throw new Error(`Clinic not found: ${code}`);
  clinicCache[code] = data.id;
  return data.id;
}

// ── Patient helpers ─────────────────────────────────────────
export async function getPatientByIdNumber(idNumber) {
  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .eq("id_number", idNumber.trim().toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertPatient(patient) {
  const { data, error } = await supabase
    .from("patients")
    .upsert({
      id_number:         patient.idNumber?.trim().toUpperCase(),
      name:              patient.name?.trim(),
      dob:               patient.dob || null,
      sex:               patient.sex || null,
      mobile:            patient.mobile || null,
      category:          patient.category || null,
      rank:              patient.rank || null,
      police_service_no: patient.policeServiceNo || null,
      address:           patient.address || null,
      notes:             patient.notes || null,
      updated_at:        new Date().toISOString(),
    }, { onConflict: "id_number" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Service helpers ─────────────────────────────────────────
export async function searchServices(query, type = null, limit = 50) {
  let q = supabase
    .from("services")
    .select("*")
    .eq("active", true)
    .ilike("name", `%${query}%`)
    .limit(limit);
  if (type) q = q.eq("type", type);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function getServiceByCode(code) {
  const { data, error } = await supabase
    .from("services")
    .select("*")
    .eq("code", code)
    .single();
  if (error) throw error;
  return data;
}

// ── Service usage tracking (for dynamic quick-picks) ──────────
export async function trackServiceUsage(clinicId, serviceCode) {
  try {
    await supabase.rpc("increment_service_usage", {
      p_clinic_id: clinicId,
      p_service_code: serviceCode,
    });
  } catch (e) {
    console.warn("trackServiceUsage:", e.message);
  }
}

const CONSULTATION_CODES = [
  "CON0001","CON0002","CON0007","CON0008","CON0009","CON0013",
  "CON0015","CON0022","CON0026","CON0027","CON0028","CON0032","CON0035",
];

export async function getQuickPickServices(clinicId, limit = 4) {
  try {
    const { data, error } = await supabase
      .from("service_usage")
      .select("service_code, usage_count")
      .eq("clinic_id", clinicId)
      .order("usage_count", { ascending: false })
      .limit(20); // fetch extra in case some are consultation codes
    if (error || !data || data.length === 0) return [];

    const nonConsultation = data.filter(d => !CONSULTATION_CODES.includes(d.service_code)).slice(0, limit);
    if (nonConsultation.length === 0) return [];

    const codes = nonConsultation.map(d => d.service_code);
    const { data: services } = await supabase
      .from("services")
      .select("*")
      .in("code", codes);
    // Preserve usage-count order
    return codes.map(c => services?.find(s => s.code === c)).filter(Boolean);
  } catch (e) {
    console.warn("getQuickPickServices:", e.message);
    return [];
  }
}

// ── Billing account helpers ─────────────────────────────────
export async function getBillingAccounts() {
  const { data, error } = await supabase
    .from("billing_accounts")
    .select("*")
    .eq("active", true)
    .order("code");
  if (error) throw error;
  return data || [];
}

// ── Memo sequence helper ────────────────────────────────────
export async function nextMemoNumber(clinicId, memoType = "clinic") {
  const today = new Date().toISOString().slice(0, 10);
  const prefix = memoType === "lab" ? "L" : "M";
  const dateStr = today.replace(/-/g, "");

  // Upsert sequence row and increment
  const { data, error } = await supabase.rpc("increment_memo_sequence", {
    p_clinic_id: clinicId,
    p_memo_type: memoType,
    p_date:      today,
  });

  if (error) {
    // Fallback if RPC not set up yet — use timestamp-based sequence
    console.warn("RPC not available, using fallback sequence:", error.message);
    const seq = Date.now().toString().slice(-4);
    return `${prefix}-${dateStr}-${seq}`;
  }

  const seq = String(data).padStart(3, "0");
  return `${prefix}-${dateStr}-${seq}`;
}

// ── Billing calculation ─────────────────────────────────────
export function calculateLineBilling(service, accountCode, patientCategory) {
  const clinicPrice      = Number(service.clinic_price) || 0;
  const aasandhaRate     = Number(service.aasandha_coverage) || 0;
  const coPayment        = Number(service.co_payment) || 0;

  // No Aasandha coverage — patient or account pays full price
  if (aasandhaRate === 0) {
    return {
      aasandha_amount: 0,
      account_amount:  0,
      patient_amount:  clinicPrice,
      line_total:      clinicPrice,
    };
  }

  // Aasandha covers their portion — figure out who pays the co-payment
  switch (accountCode) {
    case "PACT":
    case "FACT":
    case "BACT":
    case "EACT":
    case "WACT":
    case "WPACT":
      // Account pays 100% of co-payment, patient pays nothing
      return {
        aasandha_amount: aasandhaRate,
        account_amount:  coPayment,
        patient_amount:  0,
        line_total:      clinicPrice,
      };

    case "RACT":
      // Account pays 50% of co-payment, patient pays 50%
      return {
        aasandha_amount: aasandhaRate,
        account_amount:  Math.round(coPayment * 0.5 * 100) / 100,
        patient_amount:  Math.round(coPayment * 0.5 * 100) / 100,
        line_total:      clinicPrice,
      };

    case "CACT":
    case "TACT":
    default:
      // Patient pays 100% of co-payment, no account
      return {
        aasandha_amount: aasandhaRate,
        account_amount:  0,
        patient_amount:  coPayment,
        line_total:      clinicPrice,
      };
  }
}
