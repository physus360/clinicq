with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the rooms tab render in Reception portal and add memo before it
# Look for the specific Reception rooms tab pattern
old = '{tab === "rooms" && (\r\n          <div className="card">\r\n            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>\r\n              <h2 className="card-title" style={{ margin: 0 }}>Assign Doctors to Rooms</h2>'

new = '{tab === "memo" && <MemoTab state={state} />}\r\n        {tab === "rooms" && (\r\n          <div className="card">\r\n            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>\r\n              <h2 className="card-title" style={{ margin: 0 }}>Assign Doctors to Rooms</h2>'

if old in content:
    content = content.replace(old, new)
    print("OK: memo render added before rooms tab")
else:
    # Try without \r
    old2 = '{tab === "rooms" && (\n          <div className="card">\n            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>\n              <h2 className="card-title" style={{ margin: 0 }}>Assign Doctors to Rooms</h2>'
    new2 = '{tab === "memo" && <MemoTab state={state} />}\n        {tab === "rooms" && (\n          <div className="card">\n            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>\n              <h2 className="card-title" style={{ margin: 0 }}>Assign Doctors to Rooms</h2>'
    if old2 in content:
        content = content.replace(old2, new2)
        print("OK: memo render added (LF version)")
    else:
        # Find it manually and show context
        idx = content.find('Assign Doctors to Rooms')
        print(f"!! Could not find pattern. 'Assign Doctors to Rooms' at position {idx}")
        print(f"Context: {repr(content[idx-300:idx+50])}")

with open('src/StaffApp.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
