with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the generate button
idx = content.find('Generate Memo')
print(f"'Generate Memo' found at positions:")
import re
for m in re.finditer('Generate Memo', content):
    print(f"  pos {m.start()}: {repr(content[m.start()-150:m.end()+20])}")
