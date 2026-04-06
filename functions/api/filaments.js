export async function onRequestGet(context) {
  // Fetch all filaments from your D1 database
  const { results } = await context.env.DB.prepare(
    "SELECT * FROM filaments ORDER BY last_updated DESC"
  ).all();
  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json" }
  });
}

export async function onRequestPost(context) {
  const data = await context.request.json();
  
  // Handle bulk import from Excel or single manual add
  const items = Array.isArray(data) ? data : [data];
  
  const stmt = context.env.DB.prepare(
    "INSERT INTO filaments (brand, material, color_name, weight_current) VALUES (?, ?, ?, ?)"
  );

  // Use a batch to execute multiple inserts efficiently
  await context.env.DB.batch(
    items.map(item => stmt.bind(item.brand, item.material, item.color_name, item.weight_current))
  );

  return new Response("Success", { status: 201 });
}