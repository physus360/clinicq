with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

changes = 0

# 1. Add consultationTier to blankPerson
old_blank = '({ name: "", idNumber: "", registrationNo: "", designation: "", email: "", contact: "", category: "staff", active: true, role: null })'
new_blank = '({ name: "", idNumber: "", registrationNo: "", designation: "", email: "", contact: "", category: "staff", consultationTier: "", active: true, role: null })'
if old_blank in content:
    content = content.replace(old_blank, new_blank)
    print("OK 1: blankPerson updated")
    changes += 1
else:
    print("!! 1: blankPerson not found")

# 2. Add consultationTier to openEdit
old_edit = 'const openEdit = (person) => { setEditing({ ...person }); setIsNew(false); setMsg(""); };'
new_edit = 'const openEdit = (person) => { setEditing({ ...person, consultationTier: person.consultationTier || "" }); setIsNew(false); setMsg(""); };'
if old_edit in content:
    content = content.replace(old_edit, new_edit)
    print("OK 2: openEdit updated")
    changes += 1
else:
    print("!! 2: openEdit not found")

# 3. Add tier dropdown after Category select — only visible for doctors
old_category_end = '''                  <option value="staff">Other</option>
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <div className="field-group" style={{ flex: 1, minWidth: "140px" }}>
                <label className="field-label">Email (needed for login)</label>'''

new_category_end = '''                  <option value="staff">Other</option>
                </select>
              </div>
            </div>
            {editing.category === "doctor" && (
              <div className="field-group">
                <label className="field-label">Consultation Tier <span className="dim" style={{ fontWeight: 400 }}>(used for memo billing)</span></label>
                <select className="field-input" value={editing.consultationTier || ""} onChange={(e) => setEditing({ ...editing, consultationTier: e.target.value })}>
                  <option value="">— Select tier —</option>
                  <option value="general">General OPD (CON0001)</option>
                  <option value="specialist_junior">Specialist - Junior (CON0002)</option>
                  <option value="specialist_senior">Specialist - Senior (CON0009)</option>
                  <option value="super_specialist">Super Specialist (CON0007)</option>
                  <option value="dental">Dental (CON0008)</option>
                  <option value="psychologist">Psychologist (CON0022)</option>
                </select>
              </div>
            )}
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <div className="field-group" style={{ flex: 1, minWidth: "140px" }}>
                <label className="field-label">Email (needed for login)</label>'''

if old_category_end in content:
    content = content.replace(old_category_end, new_category_end)
    print("OK 3: Consultation tier dropdown added")
    changes += 1
else:
    print("!! 3: Category end not found")

# 4. Show tier badge in staff directory table
old_table = '                    <div className="dim" style={{ fontSize: "0.75rem" }}>{p.designation}{p.idNumber ? ` · ${p.idNumber}` : ""}</div>'
new_table = '''                    <div className="dim" style={{ fontSize: "0.75rem" }}>{p.designation}{p.idNumber ? ` · ${p.idNumber}` : ""}</div>
                    {p.category === "doctor" && p.consultationTier && (
                      <div style={{ fontSize: "0.7rem", color: "var(--blue)", marginTop: "0.1rem" }}>
                        {p.consultationTier === "general" ? "General OPD" :
                         p.consultationTier === "specialist_junior" ? "Specialist - Junior" :
                         p.consultationTier === "specialist_senior" ? "Specialist - Senior" :
                         p.consultationTier === "super_specialist" ? "Super Specialist" :
                         p.consultationTier === "dental" ? "Dental" :
                         p.consultationTier === "psychologist" ? "Psychologist" : p.consultationTier}
                      </div>
                    )}'''

if old_table in content:
    content = content.replace(old_table, new_table)
    print("OK 4: Tier badge in table")
    changes += 1
else:
    print("!! 4: Table row not found")

with open('src/StaffApp.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print(f"\nDone - {changes} changes applied. Restart npm run dev.")
