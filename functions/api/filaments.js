/**
 * GET    /api/filaments       → all filaments
 * POST   /api/filaments       → bulk_import | add_single
 * PUT    /api/filaments/:id   → update a spool
 * DELETE /api/filaments/:id   → delete a spool
 */

export async function onRequestGet(context) {
    const { results } = await context.env.DB.prepare(
        "SELECT * FROM filaments ORDER BY material ASC, brand ASC, color_name ASC"
    ).all();
    return json(results);
}

export async function onRequestPost(context) {
    const data = await context.request.json();
    const db = context.env.DB;

    if (data.action === 'bulk_import') {
        if (!Array.isArray(data.items) || !data.items.length)
            return json({ error: 'No items' }, 400);

        await db.prepare("DELETE FROM filaments").run();

        const stmt = db.prepare(`
            INSERT INTO filaments
                (brand, material, color_name, style, code, barcode, web_address, weight_current, color_hex, total_purchased)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const CHUNK = 90;
        for (let i = 0; i < data.items.length; i += CHUNK) {
            const chunk = data.items.slice(i, i + CHUNK);
            await db.batch(chunk.map(item => stmt.bind(
                item.brand ?? null, item.material ?? null, item.color_name ?? null,
                item.style ?? null, item.code ?? null, item.barcode ?? null,
                item.web_address ?? null, item.weight_current ?? 1000,
                item.color_hex ?? null, item.total_purchased ?? null
            )));
        }
        return json({ ok: true, count: data.items.length }, 201);
    }

    if (data.action === 'add_single') {
        const i = data.item;
        const { meta } = await db.prepare(`
            INSERT INTO filaments (brand, material, color_name, style, weight_current, color_hex, web_address)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
            i.brand ?? null, i.material ?? null, i.color_name ?? null,
            i.style ?? null, i.weight_current ?? 1000,
            i.color_hex ?? null, i.web_address ?? null
        ).run();
        return json({ ok: true, id: meta.last_row_id }, 201);
    }

    return json({ error: 'Unknown action' }, 400);
}

export async function onRequestPut(context) {
    // Extract ID from URL: /api/filaments/123
    const url = new URL(context.request.url);
    const id = url.pathname.split('/').pop();
    if (!id || isNaN(parseInt(id))) return json({ error: 'Invalid id' }, 400);

    const i = await context.request.json();
    await context.env.DB.prepare(`
        UPDATE filaments
        SET brand=?, material=?, color_name=?, style=?,
            weight_current=?, color_hex=?, web_address=?,
            last_updated=CURRENT_TIMESTAMP
        WHERE id=?
    `).bind(
        i.brand ?? null, i.material ?? null, i.color_name ?? null,
        i.style ?? null, i.weight_current ?? 1000,
        i.color_hex ?? null, i.web_address ?? null,
        parseInt(id)
    ).run();
    return json({ ok: true });
}

export async function onRequestDelete(context) {
    const url = new URL(context.request.url);
    const id = url.pathname.split('/').pop();
    if (!id || isNaN(parseInt(id))) return json({ error: 'Invalid id' }, 400);

    await context.env.DB.prepare("DELETE FROM usage_logs WHERE filament_id=?").bind(parseInt(id)).run();
    await context.env.DB.prepare("DELETE FROM filaments WHERE id=?").bind(parseInt(id)).run();
    return json({ ok: true });
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
// Add this to your filaments.js API
export async function onRequestPost(context) {
    const data = await context.request.json();
    const db = context.env.DB;

    if (data.action === 'bulk_import') {
        // ... existing bulk_import code ...
    }

    if (data.action === 'add_single') {
        // ... existing add_single code ...
    }

    if (data.action === 'delete_all') {
        await db.prepare("DELETE FROM filaments").run();
        return json({ ok: true, deleted: 'all' }, 200);
    }

    return json({ error: 'Unknown action' }, 400);
}
