with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# The issue: addLine is called inside an async useEffect during lookup
# but setLines (state update) doesn't persist because we pass accountCode
# before it's set. Fix: auto-add consultation after phase changes to "build"
# by storing a pendingLine and adding it in a separate useEffect

old_lookup_autoAdd = '''        if (doctor?.consultationTier && memoType === "clinic") {
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
          }'''

new_lookup_autoAdd = '''        if (doctor?.consultationTier && memoType === "clinic") {
            const codes = TIER_CODES[doctor.consultationTier];
            if (codes) {
              const conCode = v.consultationType === "Online"
                ? codes.online
                : v.isFollowUp ? codes.followup : codes.walkin;
              if (conCode) {
                const { getServiceByCode } = await import("./supabase.js");
                try {
                  const svc = await getServiceByCode(conCode);
                  if (svc) setPendingConsultation(svc);
                } catch {}
              }
            }
          }'''

if old_lookup_autoAdd in content:
    content = content.replace(old_lookup_autoAdd, new_lookup_autoAdd)
    print("OK 1: auto-add replaced with pendingConsultation")
else:
    print("!! 1: auto-add not found")

# Add pendingConsultation state after other state declarations
old_state = "  const [clinicId, setClinicId] = useState(null);"
new_state = "  const [clinicId, setClinicId] = useState(null);\n  const [pendingConsultation, setPendingConsultation] = useState(null);"
if old_state in content:
    content = content.replace(old_state, new_state)
    print("OK 2: pendingConsultation state added")
else:
    print("!! 2: clinicId state not found")

# Add useEffect to apply pendingConsultation when phase changes to build
old_clinic_effect = "  // Load clinic ID on mount\n  useEffect(() => {\n    import(\"./supabase.js\").then(({ getClinicId }) => {\n      getClinicId(\"MALE\").then(setClinicId).catch(console.error);\n    });\n  }, []);"

new_clinic_effect = """  // Load clinic ID on mount
  useEffect(() => {
    import("./supabase.js").then(({ getClinicId }) => {
      getClinicId("MALE").then(setClinicId).catch(console.error);
    });
  }, []);

  // Apply pending consultation line once phase is "build" and lines are empty
  useEffect(() => {
    if (phase === "build" && pendingConsultation && lines.length === 0) {
      addLine(pendingConsultation, accountCode);
      setPendingConsultation(null);
    }
  }, [phase, pendingConsultation]);"""

if old_clinic_effect in content:
    content = content.replace(old_clinic_effect, new_clinic_effect)
    print("OK 3: pending consultation useEffect added")
else:
    print("!! 3: clinic effect not found")

with open('src/StaffApp.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
print("Done. Restart npm run dev.")
