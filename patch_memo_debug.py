with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Add console.log at start of generate function
old = "  const generate = async () => {\n    if (lines.length === 0) { setMsg(\"Add at least one service.\"); return; }\n    if (!clinicId) { setMsg(\"Clinic not configured.\"); return; }\n    setGenerating(true); setMsg(\"\");"

new = "  const generate = async () => {\n    console.log(\"Generate clicked. lines:\", lines.length, \"clinicId:\", clinicId, \"patient:\", patient?.id);\n    if (lines.length === 0) { setMsg(\"Add at least one service.\"); return; }\n    if (!clinicId) { setMsg(\"Clinic not configured. Check Supabase connection.\"); return; }\n    setGenerating(true); setMsg(\"\");"

if old in content:
    content = content.replace(old, new)
    print("OK: debug logging added")
else:
    print("!! generate function not found")
    # Find it
    idx = content.find("const generate = async")
    print(f"generate found at: {idx}")
    print(repr(content[idx:idx+200]))

with open('src/StaffApp.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
print("Done. Restart and check console when clicking Generate.")
