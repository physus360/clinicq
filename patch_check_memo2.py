with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Check tab render
idx = content.find('"memo" && <MemoTab')
print(f"Memo tab render: {'FOUND' if idx != -1 else 'NOT FOUND'}")
if idx != -1:
    print(f"Context: {repr(content[idx-30:idx+40])}")

# Check tab in array
idx2 = content.find('"memo"')
print(f"\nFirst 'memo' reference at {idx2}: {repr(content[idx2-20:idx2+30])}")

# Check all memo references
import re
for m in re.finditer(r'"memo"', content):
    print(f"  pos {m.start()}: {repr(content[m.start()-30:m.end()+30])}")
