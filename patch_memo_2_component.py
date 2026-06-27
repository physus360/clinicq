# Stage 2: Add MemoTab component to StaffApp.jsx
# Run from C:\clinicq: python patch_memo_2_component.py

with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

MEMO_COMPONENT = r"""
/* ═══════════════════════════════════════════
   MEMO TAB — Clinic & Lab Memo Generation
   Reception only. Uses Supabase for all data.
═══════════════════════════════════════════ */

// Consultation tier → service codes mapping
const TIER_CODES = {
  general:           { walkin: "CON0001", online: "CON0026", midnight: "CON0015", followup: "CON0013" },
  specialist_junior: { walkin: "CON0002", online: "CON0035", midnight: "CON0015", followup: "CON0013" },
  specialist_senior: { walkin: "CON0009", online: "CON0027", midnight: "CON0015", followup: "CON0013" },
  super_specialist:  { walkin: "CON0007", online: "CON0028", midnight: "CON0015", followup: "CON0013" },
  dental:            { walkin: "CON0008", online: "CON0008", midnight: "CON0015", followup: "CON0013" },
  psychologist:      { walkin: "CON0022", online: "CON0022", midnight: "CON0015", followup: "CON0013" },
};

const ACCOUNT_LABELS = {
  PACT: "Police Account", FACT: "Police Family Account", BACT: "Arrest Account",
  EACT: "Emergency Account", CACT: "Citizen Account", WACT: "Polwec Account",
  RACT: "Retired Police Account", WPACT: "WP Holder Account", TACT: "Tourist Account",
};

const ACCOUNT_OPTIONS = Object.entries(ACCOUNT_LABELS).map(([code, name]) => ({ code, name }));

// Auto-suggest account based on patient category
function suggestAccount(patientCategory) {
  switch (patientCategory) {
    case "Police":         return "PACT";
    case "Police EXO":     return "PACT";
    case "Police Family":  return "FACT";
    case "Police Custody": return "BACT";
    case "Emergency":      return "EACT";
    default:               return "CACT";
  }
}

function calculateLineBilling(service, accountCode) {
  const clinicPrice     = Number(service.clinic_price) || 0;
  const aasandhaRate    = Number(service.aasandha_coverage) || 0;
  const coPayment       = Number(service.co_payment) || 0;

  if (aasandhaRate === 0) {
    // No Aasandha coverage
    return { aasandha: 0, account: 0, patient: clinicPrice, total: clinicPrice };
  }

  switch (accountCode) {
    case "PACT": case "FACT": case "BACT": case "EACT": case "WACT": case "WPACT":
      return { aasandha: aasandhaRate, account: coPayment, patient: 0, total: clinicPrice };
    case "RACT":
      const half = Math.round(coPayment * 0.5 * 100) / 100;
      return { aasandha: aasandhaRate, account: half, patient: half, total: clinicPrice };
    default: // CACT, TACT
      return { aasandha: aasandhaRate, account: 0, patient: coPayment, total: clinicPrice };
  }
}

function MemoTab({ state }) {
  const { user } = useAuth();
  const [memoType, setMemoType] = useState("clinic"); // clinic | lab
  const [phase, setPhase] = useState("lookup");        // lookup | build | done
  const [idInput, setIdInput] = useState("");
  const [lookupMsg, setLookupMsg] = useState("");
  const [patient, setPatient] = useState(null);
  const [visit, setVisit] = useState(null);
  const [accountCode, setAccountCode] = useState("CACT");
  const [lines, setLines] = useState([]);
  const [serviceSearch, setServiceSearch] = useState("");
  const [serviceResults, setServiceResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg] = useState("");
  const [generatedMemo, setGeneratedMemo] = useState(null);
  const [clinicId, setClinicId] = useState(null);

  // Load clinic ID on mount
  useEffect(() => {
    import("./supabase.js").then(({ getClinicId }) => {
      getClinicId("MALE").then(setClinicId).catch(console.error);
    });
  }, []);

  // Search services
  useEffect(() => {
    if (serviceSearch.trim().length < 2) { setServiceResults([]); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const { searchServices } = await import("./supabase.js");
        const results = await searchServices(serviceSearch, memoType === "lab" ? "lab" : "clinic", 20);
        setServiceResults(results);
      } catch (e) { console.warn("service search:", e.message); }
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [serviceSearch, memoType]);

  const lookup = async () => {
    const id = idInput.trim().toUpperCase();
    if (!id) return;
    setLookupMsg("Searching..."); setMsg("");
    try {
      const { getPatientByIdNumber } = await import("./supabase.js");
      const p = await getPatientByIdNumber(id);
      if (p) {
        setPatient(p);
        setAccountCode(suggestAccount(p.category));
        setLookupMsg("Patient found: " + p.name);
        // Look for today's visit in Firestore
        const today = new Date().toISOString().slice(0, 10);
        const q = query(VISITS_COL,
          where("patientId", "==", p.id_number),
          where("date", "==", today),
          where("status", "in", ["waiting", "served"])
        );
        const snap = await getDocs(q);
        if (!snap.empty) {
          const v = { id: snap.docs[0].id, ...snap.docs[0].data() };
          setVisit(v);
          // Auto-add consultation line if doctor has a tier
          const doctor = Object.values(state.doctorDirectory || {}).find(
            d => d.id === v.doctorId || d.name === v.doctorName
          );
          if (doctor?.consultationTier && memoType === "clinic") {
            const codes = TIER_CODES[doctor.consultationTier];
            if (codes) {
              const conCode = v.consultationType === "Online"
                ? codes.online
                : v.isFollowUp ? codes.followup : codes.walkin;
              if (conCode) {
                const { getServiceByCode } = await import("./supabase.js");
                try {
                  const svc = await getServiceByCode(conCode);
                  if (svc) addLine(svc, accountCode);
                } catch {}
              }
            }
          }
        }
        setPhase("build");
      } else {
        setLookupMsg("Patient not found. Please register first in Patients tab.");
      }
    } catch (e) { setLookupMsg("Error: " + e.message); }
  };

  const addLine = (service, acCode = accountCode) => {
    const existing = lines.find(l => l.code === service.code);
    if (existing) {
      setLines(prev => prev.map(l => l.code === service.code
        ? { ...l, qty: l.qty + 1, ...recalcLine({ ...l, qty: l.qty + 1 }, acCode) }
        : l
      ));
    } else {
      const billing = calculateLineBilling(service, acCode);
      setLines(prev => [...prev, {
        code: service.code,
        name: service.name,
        category: service.category,
        service_id: service.id,
        unit_price: Number(service.clinic_price),
        qty: 1,
        ...billing,
      }]);
    }
    setServiceSearch(""); setServiceResults([]);
  };

  const recalcLine = (line, acCode) => {
    const svc = { clinic_price: line.unit_price, aasandha_coverage: line.aasandha / line.qty, co_payment: line.patient / line.qty };
    return calculateLineBilling(svc, acCode);
  };

  const removeLine = (code) => setLines(prev => prev.filter(l => l.code !== code));

  const updateQty = (code, qty) => {
    if (qty < 1) return;
    setLines(prev => prev.map(l => {
      if (l.code !== code) return l;
      const factor = qty / l.qty;
      return { ...l, qty, aasandha: Math.round(l.aasandha * factor * 100) / 100, account: Math.round(l.account * factor * 100) / 100, patient: Math.round(l.patient * factor * 100) / 100, total: Math.round(l.total * factor * 100) / 100 };
    }));
  };

  const totals = lines.reduce((acc, l) => ({
    aasandha: acc.aasandha + l.aasandha,
    account:  acc.account  + l.account,
    patient:  acc.patient  + l.patient,
    total:    acc.total    + l.total,
  }), { aasandha: 0, account: 0, patient: 0, total: 0 });

  const generate = async () => {
    if (lines.length === 0) { setMsg("Add at least one service."); return; }
    if (!clinicId) { setMsg("Clinic not configured."); return; }
    setGenerating(true); setMsg("");
    try {
      const { supabase, nextMemoNumber } = await import("./supabase.js");
      const memoNo = await nextMemoNumber(clinicId, memoType);
      const today = new Date().toISOString().slice(0, 10);
      const table = memoType === "lab" ? "lab_memos" : "memos";
      const lineTable = memoType === "lab" ? "lab_memo_lines" : "memo_lines";

      // Insert memo
      const { data: memo, error: memoErr } = await supabase.from(table).insert({
        clinic_id:      clinicId,
        memo_no:        memoNo,
        date:           today,
        patient_id:     patient.id,
        account_code:   accountCode,
        doctor_name:    visit?.doctorName || "",
        room:           visit?.room || "",
        token:          visit?.token || null,
        total_aasandha: Math.round(totals.aasandha * 100) / 100,
        total_account:  Math.round(totals.account  * 100) / 100,
        total_patient:  Math.round(totals.patient  * 100) / 100,
        total_amount:   Math.round(totals.total    * 100) / 100,
        status:         "active",
        created_by:     user?.email || "",
      }).select().single();

      if (memoErr) throw new Error(memoErr.message);

      // Insert lines
      const lineRows = lines.map((l, i) => ({
        [memoType === "lab" ? "lab_memo_id" : "memo_id"]: memo.id,
        service_id:      l.service_id,
        service_code:    l.code,
        service_name:    l.name,
        qty:             l.qty,
        unit_price:      l.unit_price,
        aasandha_amount: l.aasandha,
        account_amount:  l.account,
        patient_amount:  l.patient,
        line_total:      l.total,
        sort_order:      i,
      }));

      const { error: lineErr } = await supabase.from(lineTable).insert(lineRows);
      if (lineErr) throw new Error(lineErr.message);

      setGeneratedMemo({ ...memo, lines, patient, accountCode, memoType });
      setPhase("done");
    } catch (e) { setMsg("Failed: " + e.message); }
    setGenerating(false);
  };

  const reset = () => {
    setPhase("lookup"); setIdInput(""); setLookupMsg(""); setPatient(null);
    setVisit(null); setLines([]); setMsg(""); setGeneratedMemo(null);
    setServiceSearch(""); setServiceResults([]);
  };

  const printMemo = async () => {
    if (!generatedMemo) return;
    const m = generatedMemo;
    const trackUrl = `${APP_URL}/#memo?id=${m.id}&type=${m.memoType}`;
    const qrDataUrl = await generateQRDataURL(trackUrl);
    const acctLabel = ACCOUNT_LABELS[m.accountCode] || m.accountCode;
    const today = new Date();
    const dateStr = today.toLocaleDateString("en-GB") + " " + today.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const hasAccount  = ["PACT","FACT","BACT","EACT","WACT","WPACT","RACT"].includes(m.accountCode);
    const hasAasandha = m.lines.some(l => l.aasandha > 0);
    const hasPatient  = m.lines.some(l => l.patient > 0);

    const w = window.open("", "_blank", "width=800,height=600");
    w.document.write(`<!DOCTYPE html><html><head><title>${m.memo_no}</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; color: #000; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
      .memo-title { text-align: center; font-size: 16px; font-weight: bold; text-decoration: underline; margin-bottom: 12px; }
      .patient-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; margin-bottom: 12px; }
      .field { display: flex; gap: 8px; }
      .field-label { font-weight: bold; min-width: 80px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
      th { border: 1px solid #000; padding: 4px 6px; background: #f0f0f0; text-align: left; font-size: 10px; }
      td { border: 1px solid #000; padding: 4px 6px; font-size: 10px; }
      td.num { text-align: right; }
      .totals-row td { font-weight: bold; background: #f9f9f9; }
      .payment { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
      .payment-box h4 { margin: 0 0 6px; font-size: 11px; }
      .payment-row { display: flex; justify-content: space-between; font-size: 10px; margin-bottom: 2px; }
      .footer { text-align: center; font-size: 9px; color: #555; border-top: 1px solid #ccc; padding-top: 6px; }
      .non-refundable { font-size: 10px; font-style: italic; text-align: right; margin-bottom: 8px; }
      .qr-section { text-align: center; margin-top: 8px; }
      @media print { body { margin: 10px; } }
    </style></head><body>
    <div class="header">
      <div>
        <div style="font-family: monospace; font-size: 24px; letter-spacing: 3px;">|||||||||||||||</div>
        <div style="font-size: 10px;">${m.memo_no}</div>
      </div>
      <div style="text-align: center; flex: 1;">
        <div class="memo-title">${m.memoType === "lab" ? "LAB MEMO" : "SERVICE MEMO"}</div>
      </div>
      <div style="text-align: right;">
        <div style="font-size: 18px; font-weight: bold; font-style: italic;">Noosandha</div>
        <div style="font-size: 9px;">Clinic</div>
      </div>
    </div>

    <div class="patient-grid">
      <div class="field"><span class="field-label">Patient no:</span> ${m.patient.id_number}</div>
      <div class="field"><span class="field-label">Memo no:</span> ${m.memo_no}</div>
      <div class="field"><span class="field-label">Name:</span> ${m.patient.name}${m.patient.id_number ? " (" + m.patient.id_number + ")" : ""}</div>
      <div class="field"><span class="field-label">Date:</span> ${dateStr}</div>
      <div class="field"><span class="field-label">Address:</span> ${m.patient.address || "—"}</div>
      <div class="field"><span class="field-label">User:</span> ${m.created_by || "—"}</div>
      <div class="field"><span class="field-label">Age / Sex:</span> ${m.patient.dob ? (new Date().getFullYear() - new Date(m.patient.dob).getFullYear()) + " / " + (m.patient.sex || "—") : (m.patient.sex || "—")}</div>
      <div class="field"><span class="field-label">${m.room ? roomDisplay(m.room) : ""}</span> ${m.token ? "Token " + m.token : ""}</div>
      <div class="field" style="grid-column: span 2"><span class="field-label">Doctor:</span> ${m.doctor_name || "—"}</div>
    </div>

    <table>
      <thead>
        <tr>
          <th>CODE</th>
          <th>SERVICE NAME</th>
          <th class="num">CLINIC PRICE</th>
          ${hasAasandha ? '<th class="num">AASANDHA</th>' : ""}
          ${hasAccount ? '<th class="num">' + m.accountCode + '</th>' : ""}
          ${hasPatient ? '<th class="num">PATIENT</th>' : ""}
          <th class="num">TOTAL</th>
        </tr>
      </thead>
      <tbody>
        ${m.lines.map(l => `
          <tr>
            <td>${l.code}</td>
            <td>${l.name}${l.qty > 1 ? " x" + l.qty : ""}</td>
            <td class="num">${l.total.toFixed(2)}</td>
            ${hasAasandha ? '<td class="num">' + (l.aasandha > 0 ? l.aasandha.toFixed(2) : "—") + "</td>" : ""}
            ${hasAccount  ? '<td class="num">' + (l.account  > 0 ? l.account.toFixed(2)  : "—") + "</td>" : ""}
            ${hasPatient  ? '<td class="num">' + (l.patient  > 0 ? l.patient.toFixed(2)  : "—") + "</td>" : ""}
            <td class="num">${l.total.toFixed(2)}</td>
          </tr>
        `).join("")}
        <tr class="totals-row">
          <td colspan="2"><strong>Total</strong></td>
          <td class="num"><strong>${totals.total.toFixed(2)}</strong></td>
          ${hasAasandha ? '<td class="num"><strong>' + totals.aasandha.toFixed(2) + "</strong></td>" : ""}
          ${hasAccount  ? '<td class="num"><strong>' + totals.account.toFixed(2)  + "</strong></td>" : ""}
          ${hasPatient  ? '<td class="num"><strong>' + totals.patient.toFixed(2)  + "</strong></td>" : ""}
          <td class="num"><strong>${totals.total.toFixed(2)}</strong></td>
        </tr>
      </tbody>
    </table>

    <div class="non-refundable">Note: This memo is non-refundable.</div>

    <div class="payment">
      ${hasAccount ? `
      <div class="payment-box">
        <h4>Payment details:</h4>
        <div class="payment-row"><span><strong>Account:</strong></span><span>${acctLabel}</span></div>
        <div class="payment-row"><span><strong>Amount:</strong></span><span>MVR ${totals.account.toFixed(2)}</span></div>
        <div class="payment-row"><span><strong>Ref no:</strong></span><span>${m.memo_no}</span></div>
      </div>` : "<div></div>"}
      ${hasAasandha ? `
      <div class="payment-box">
        <h4>&nbsp;</h4>
        <div class="payment-row"><span><strong>Account:</strong></span><span>Aasandha</span></div>
        <div class="payment-row"><span><strong>Amount:</strong></span><span>MVR ${totals.aasandha.toFixed(2)}</span></div>
        <div class="payment-row"><span><strong>Transaction id:</strong></span><span>${m.memo_no}</span></div>
      </div>` : ""}
      ${hasPatient && !hasAccount ? `
      <div class="payment-box">
        <h4>Payment details:</h4>
        <div class="payment-row"><span><strong>Amount:</strong></span><span>MVR ${totals.patient.toFixed(2)}</span></div>
        <div class="payment-row"><span><strong>Ref no:</strong></span><span>${m.memo_no}</span></div>
      </div>` : ""}
    </div>

    ${qrDataUrl ? `<div class="qr-section"><img src="${qrDataUrl}" width="80" height="80" alt="QR"/><div style="font-size:9px;color:#888">Scan to view memo</div></div>` : ""}

    <div class="footer">
      Noosandha Maldives, Maldives Police Service, Medical Service Department<br/>
      Ameeneemagu, Male' Maldives, Phone: 3300078, 9514450 / Fax: 3011549
    </div>
    <script>setTimeout(() => window.print(), 400);</script>
    </body></html>`);
    w.document.close(); w.focus();
  };

  const shareWhatsApp = () => {
    if (!generatedMemo || !patient?.mobile) return;
    const url = `${APP_URL}/#memo?id=${generatedMemo.id}&type=${generatedMemo.memoType}`;
    const msg = `Dear ${patient.name.split(" ")[0]}, your Noosandha Clinic memo ${generatedMemo.memo_no} is ready. View here: ${url}`;
    window.open(`https://wa.me/${patient.mobile.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(msg)}`, "_blank");
  };

  const shareViber = () => {
    if (!generatedMemo) return;
    const url = `${APP_URL}/#memo?id=${generatedMemo.id}&type=${generatedMemo.memoType}`;
    const msg = `Dear ${patient.name.split(" ")[0]}, your Noosandha Clinic memo ${generatedMemo.memo_no} is ready. View here: ${url}`;
    window.open(`viber://forward?text=${encodeURIComponent(msg)}`, "_blank");
  };

  return (
    <div>
      {/* Memo type toggle */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button className={`btn ${memoType === "clinic" ? "btn-blue" : "btn-outline"}`} onClick={() => { setMemoType("clinic"); reset(); }}>
          🏥 Clinic Memo
        </button>
        <button className={`btn ${memoType === "lab" ? "btn-blue" : "btn-outline"}`} onClick={() => { setMemoType("lab"); reset(); }}>
          🧪 Lab Memo
        </button>
      </div>

      {/* Phase: Lookup */}
      {phase === "lookup" && (
        <div className="card">
          <h2 className="card-title">Patient Lookup</h2>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input className="field-input" placeholder="Patient ID / Passport" value={idInput}
              onChange={(e) => setIdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && lookup()} />
            <button className="btn btn-blue" onClick={lookup}>🔍 Search</button>
          </div>
          {lookupMsg && (
            <div style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: lookupMsg.startsWith("Patient found") ? "var(--green)" : "var(--red)" }}>
              {lookupMsg}
            </div>
          )}
        </div>
      )}

      {/* Phase: Build memo */}
      {phase === "build" && patient && (
        <div>
          {/* Patient summary */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>{patient.name}</div>
                <div className="dim" style={{ fontSize: "0.82rem" }}>
                  {patient.id_number}
                  {patient.dob ? ` · Age ${new Date().getFullYear() - new Date(patient.dob).getFullYear()}` : ""}
                  {patient.sex ? ` · ${patient.sex}` : ""}
                  {patient.category !== "General" ? ` · ${patient.category}` : ""}
                  {patient.police_service_no ? ` · Svc: ${patient.police_service_no}` : ""}
                </div>
                {visit && (
                  <div className="dim" style={{ fontSize: "0.78rem", marginTop: "0.2rem" }}>
                    Token {visit.token} · {visit.doctorName} · {visit.consultationType}
                    {visit.isFollowUp ? " · Follow-up" : ""}
                  </div>
                )}
              </div>
              <button className="btn btn-outline btn-sm" onClick={reset}>✕ Change</button>
            </div>
          </div>

          {/* Account selection */}
          <div className="card">
            <div className="field-group">
              <label className="field-label">Billing Account</label>
              <select className="field-input" value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
                {ACCOUNT_OPTIONS.map(a => (
                  <option key={a.code} value={a.code}>{a.code} — {a.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Service search */}
          <div className="card">
            <h2 className="card-title">Add Services</h2>
            <div style={{ position: "relative" }}>
              <input className="field-input" placeholder={`Search ${memoType} services...`}
                value={serviceSearch}
                onChange={(e) => setServiceSearch(e.target.value)} />
              {searching && <div className="dim" style={{ fontSize: "0.78rem", marginTop: "0.3rem" }}>Searching...</div>}
              {serviceResults.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", zIndex: 100, maxHeight: "280px", overflowY: "auto", boxShadow: "var(--shadow)" }}>
                  {serviceResults.map(s => (
                    <div key={s.code} style={{ padding: "0.6rem 0.75rem", cursor: "pointer", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                      onClick={() => addLine(s)}
                      onMouseEnter={e => e.currentTarget.style.background = "var(--bg)"}
                      onMouseLeave={e => e.currentTarget.style.background = ""}>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: "0.85rem" }}>{s.name}</div>
                        <div className="dim" style={{ fontSize: "0.75rem" }}>{s.code} · {s.category}</div>
                      </div>
                      <div style={{ textAlign: "right", fontSize: "0.82rem" }}>
                        <div>MVR {Number(s.clinic_price).toFixed(2)}</div>
                        {s.aasandha_coverage > 0 && <div className="dim">Aas: {Number(s.aasandha_coverage).toFixed(2)}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Lines table */}
            {lines.length > 0 && (
              <div style={{ marginTop: "1rem" }}>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Service</th>
                        <th style={{ textAlign: "right" }}>Qty</th>
                        <th style={{ textAlign: "right" }}>Clinic</th>
                        <th style={{ textAlign: "right" }}>Aasandha</th>
                        <th style={{ textAlign: "right" }}>{accountCode}</th>
                        <th style={{ textAlign: "right" }}>Patient</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map(l => (
                        <tr key={l.code}>
                          <td className="mono" style={{ fontSize: "0.78rem" }}>{l.code}</td>
                          <td style={{ fontSize: "0.82rem" }}>{l.name}</td>
                          <td style={{ textAlign: "right" }}>
                            <div style={{ display: "flex", gap: "0.25rem", justifyContent: "flex-end", alignItems: "center" }}>
                              <button className="btn btn-outline btn-sm" style={{ padding: "0.1rem 0.3rem" }} onClick={() => updateQty(l.code, l.qty - 1)}>−</button>
                              <span style={{ minWidth: "20px", textAlign: "center" }}>{l.qty}</span>
                              <button className="btn btn-outline btn-sm" style={{ padding: "0.1rem 0.3rem" }} onClick={() => updateQty(l.code, l.qty + 1)}>+</button>
                            </div>
                          </td>
                          <td style={{ textAlign: "right", fontSize: "0.82rem" }}>{l.total.toFixed(2)}</td>
                          <td style={{ textAlign: "right", fontSize: "0.82rem", color: "var(--blue)" }}>{l.aasandha > 0 ? l.aasandha.toFixed(2) : "—"}</td>
                          <td style={{ textAlign: "right", fontSize: "0.82rem", color: "var(--green)" }}>{l.account > 0 ? l.account.toFixed(2) : "—"}</td>
                          <td style={{ textAlign: "right", fontSize: "0.82rem", color: "var(--red)" }}>{l.patient > 0 ? l.patient.toFixed(2) : "—"}</td>
                          <td><button className="btn btn-outline btn-sm" style={{ color: "var(--red)" }} onClick={() => removeLine(l.code)}>✕</button></td>
                        </tr>
                      ))}
                      <tr style={{ fontWeight: 700, background: "var(--bg)" }}>
                        <td colSpan={3}>Total</td>
                        <td style={{ textAlign: "right" }}>{totals.total.toFixed(2)}</td>
                        <td style={{ textAlign: "right", color: "var(--blue)" }}>{totals.aasandha.toFixed(2)}</td>
                        <td style={{ textAlign: "right", color: "var(--green)" }}>{totals.account.toFixed(2)}</td>
                        <td style={{ textAlign: "right", color: "var(--red)" }}>{totals.patient.toFixed(2)}</td>
                        <td></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {msg && <div style={{ color: "var(--red)", fontSize: "0.82rem", marginTop: "0.5rem" }}>{msg}</div>}

            <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
              <button className="btn btn-green" onClick={generate} disabled={generating || lines.length === 0}>
                {generating ? "Generating..." : "🧾 Generate Memo"}
              </button>
              <button className="btn btn-outline" onClick={reset}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Phase: Done */}
      {phase === "done" && generatedMemo && (
        <div className="card">
          <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>✅</div>
            <div style={{ fontWeight: 700, fontSize: "1.1rem" }}>{generatedMemo.memo_no}</div>
            <div className="dim" style={{ fontSize: "0.85rem" }}>
              {generatedMemo.memoType === "lab" ? "Lab Memo" : "Clinic Memo"} · {patient.name} · MVR {totals.total.toFixed(2)}
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", flexWrap: "wrap" }}>
            <button className="btn btn-blue" onClick={printMemo}>🖨 Print</button>
            <button className="btn btn-outline" style={{ background: "#25D366", color: "#fff", border: "none" }} onClick={shareWhatsApp}>
              WhatsApp
            </button>
            <button className="btn btn-outline" style={{ background: "#7360f2", color: "#fff", border: "none" }} onClick={shareViber}>
              Viber
            </button>
            <button className="btn btn-outline" onClick={reset}>New Memo</button>
          </div>
        </div>
      )}
    </div>
  );
}

"""

# Insert before GLOBAL_CSS
if 'function MemoTab' not in content:
    content = content.replace('const GLOBAL_CSS = `', MEMO_COMPONENT + 'const GLOBAL_CSS = `', 1)
    print("OK: MemoTab component added")
else:
    print("MemoTab already exists")

with open('src/StaffApp.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done. Run npm run dev to test.")
