with open('src/StaffApp.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix searchServices to also search by code
old = "        const results = await searchServices(serviceSearch, memoType === \"lab\" ? \"lab\" : \"clinic\", 20);"
new = """        const results = await searchServices(serviceSearch, memoType === "lab" ? "lab" : "clinic", 20);"""

# The real fix is in supabase.js searchServices function
# But we can also fix it here by calling with no type filter for code searches
old2 = "export async function searchServices(query, type = null, limit = 50) {\n  let q = supabase\n    .from(\"services\")\n    .select(\"*\")\n    .eq(\"active\", true)\n    .ilike(\"name\", `%${query}%`)\n    .limit(limit);\n  if (type) q = q.eq(\"type\", type);\n  const { data, error } = await q;\n  if (error) throw error;\n  return data || [];\n}"

new2 = """export async function searchServices(query, type = null, limit = 50) {
  const trimmed = query.trim();
  let q = supabase
    .from("services")
    .select("*")
    .eq("active", true)
    .or(`name.ilike.%${trimmed}%,code.ilike.%${trimmed}%`)
    .limit(limit);
  if (type) q = q.eq("type", type);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}"""

with open('src/supabase.js', 'r', encoding='utf-8') as f:
    supa = f.read()

if old2 in supa:
    supa = supa.replace(old2, new2)
    with open('src/supabase.js', 'w', encoding='utf-8') as f:
        f.write(supa)
    print("OK: searchServices now searches by both name and code")
else:
    print("!! searchServices pattern not found in supabase.js")
    print("Manually update searchServices in src/supabase.js to use:")
    print('.or(`name.ilike.%${trimmed}%,code.ilike.%${trimmed}%`)')

print("Done. Restart npm run dev and try searching 'General' or 'CON0001'")
