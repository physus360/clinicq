with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the service results dropdown
idx = content.find('serviceResults.map')
print(f"serviceResults.map at {idx}")
if idx != -1:
    print(repr(content[idx-100:idx+300]))
