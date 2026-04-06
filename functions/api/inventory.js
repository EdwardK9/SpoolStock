export async function onRequestGet(context) {
    const { results } = await context.env.DB.prepare("SELECT * FROM filaments ORDER BY id DESC").all();
    return new Response(JSON.stringify(results));
}

export async function onRequestPost(context) {
    const data = await context.request.json();
    const db = context.env.DB;

    // 1. Handle the Excel Import (using your headers)
    if (data.action === 'bulk_import') {
        const stmt = db.prepare(`
            INSERT INTO filaments (brand, material, color_name, style, code, barcode, web_address, weight_current) 
            VALUES (?, ?, ?, ?, ?, ?, ?, 1000)
        `);
        await db.batch(data.items.map(i => 
            stmt.bind(i.brand, i.material, i.color, i.style, i.code, i.barcode, i.web)
        ));
    } 
    
    // 2. Handle the 3MF Weight Deduction
    if (data.action === 'log_usage') {
        await db.batch([
            db.prepare("UPDATE filaments SET weight_current = weight_current - ? WHERE id = ?").bind(data.grams, data.id),
            db.prepare("INSERT INTO usage_logs (filament_id, project_name, weight_used) VALUES (?, ?, ?)").bind(data.id, data.project, data.grams)
        ]);
    }

    return new Response("Success");
}