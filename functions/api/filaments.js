/**
 * GET  /api/filaments  → returns all filaments
 * POST /api/filaments  → bulk_import | add_single
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
        if (!Array.isArray(data.items) || !data.items.length) {
            return json({ error: 'No items provided' }, 400);
        }

        // Wipe existing data and re-import fresh (simplest safe approach)
        await db.prepare("DELETE FROM filaments").run();

        const stmt = db.prepare(`
            INSERT INTO filaments 
                (brand, material, color_name, style, code, barcode, web_address, weight_current, color_hex, total_purchased)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // D1 batch limit is 100 statements — chunk if needed
        const CHUNK = 90;
        for (let i = 0; i < data.items.length; i += CHUNK) {
            const chunk = data.items.slice(i, i + CHUNK);
            await db.batch(
                chunk.map(item => stmt.bind(
                    item.brand          ?? null,
                    item.material       ?? null,
                    item.color_name     ?? null,
                    item.style          ?? null,
                    item.code           ?? null,
                    item.barcode        ?? null,
                    item.web_address    ?? null,
                    item.weight_current ?? 1000,
                    item.color_hex      ?? null,
                    item.total_purchased ?? null
                ))
            );
        }
        return json({ ok: true, count: data.items.length }, 201);
    }

    if (data.action === 'add_single') {
        const i = data.item;
        const { meta } = await db.prepare(`
            INSERT INTO filaments (brand, material, color_name, style, weight_current, color_hex)
            VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
            i.brand ?? null, i.material ?? null, i.color_name ?? null,
            i.style ?? null, i.weight_current ?? 1000, i.color_hex ?? null
        ).run();
        return json({ ok: true, id: meta.last_row_id }, 201);
    }

    return json({ error: 'Unknown action' }, 400);
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        }
    });
}
