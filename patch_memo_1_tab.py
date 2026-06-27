# Stage 1: Add memo tab to Reception portal
# Run from C:\clinicq: python patch_memo_1_tab.py

with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

changes = 0

# Add memo to tab list and label
old = '"appointments", "active", "patients", "rooms"].map'
new = '"appointments", "active", "patients", "rooms", "memo"].map'
if old in content:
    content = content.replace(old, new)
    print("OK 1: memo added to tab array")
    changes += 1
else:
    print("!! 1: tab array not found")

# Add memo label in ternary
old2 = ': "🏥 Rooms"}'
new2 = ': t === "memo" ? "🧾 Memo" : "🏥 Rooms"}'
if old2 in content and 'memo' not in content[content.find('"🏥 Rooms"')-50:content.find('"🏥 Rooms"')]:
    content = content.replace(old2, new2, 1)
    print("OK 2: memo label added")
    changes += 1
else:
    print("!! 2: label not found or already present")

# Add memo tab render - find where rooms tab is rendered in Reception
old3 = '{tab === "rooms" && (\r\n          <div className="card">\r\n            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>\r\n              <h2 className="card-title" style={{ margin: 0 }}>Assign Doctors to Rooms</h2>'
new3 = '{tab === "memo" && <MemoTab state={state} />}\r\n        {tab === "rooms" && (\r\n          <div className="card">\r\n            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>\r\n              <h2 className="card-title" style={{ margin: 0 }}>Assign Doctors to Rooms</h2>'

if old3 in content:
    content = content.replace(old3, new3)
    print("OK 3: memo tab render added")
    changes += 1
else:
    print("!! 3: rooms tab render not found")

with open('src/StaffApp.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print(f"\nDone - {changes} changes. Run patch_memo_2_component.py next.")
