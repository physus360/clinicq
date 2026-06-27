with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Check for generate function
idx = content.find('const generate = async')
print(f"generate function: {'FOUND' if idx != -1 else 'NOT FOUND'}")
if idx != -1:
    print(repr(content[idx:idx+300]))

# Check for addLine function
idx2 = content.find('const addLine = ')
print(f"\naddLine function: {'FOUND' if idx2 != -1 else 'NOT FOUND'}")

# Check for MemoTab return statement
idx3 = content.find('function MemoTab')
if idx3 != -1:
    # Find the return statement
    ret = content.find('return (', idx3)
    print(f"\nMemoTab return: {'FOUND' if ret != -1 else 'NOT FOUND'}")
    if ret != -1:
        print(repr(content[ret:ret+200]))
