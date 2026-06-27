with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Find MemoTab
idx = content.find('function MemoTab')
if idx == -1:
    print("MemoTab NOT FOUND in file")
else:
    print(f"MemoTab found at position {idx}")
    # Check what's before it
    before = content[idx-200:idx]
    print(f"Before MemoTab: {repr(before[-100:])}")

# Check where GLOBAL_CSS is
css_idx = content.find('const GLOBAL_CSS')
print(f"\nGLOBAL_CSS at position {css_idx}")
print(f"MemoTab is {'BEFORE' if idx < css_idx else 'AFTER'} GLOBAL_CSS")

# Check if MemoTab is inside a comment
comment_start = content.rfind('/*', 0, idx)
comment_end = content.find('*/', comment_start) if comment_start != -1 else -1
if comment_start != -1 and comment_end > idx:
    print(f"\nWARNING: MemoTab is INSIDE a comment block!")
    print(f"Comment starts at {comment_start}, ends at {comment_end}")
else:
    print(f"\nMemoTab is NOT inside a comment block - good")
