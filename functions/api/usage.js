/**
 * GET  /api/usage  → returns usage log with filament labels
 * POST /api/usage  → log filament usage (deducts from spool)
 */

export async function onRequestGet(context) {
    const { results } = await context.env.DB.prepare(`
        SELECT 
            u.id,
            u.filament_id,
            u.project_name,
            u.weight_used,
            u.created_at,
            (f.brand || ' ' || f.color_name) AS filament_label
        FROM usage_logs u
        LEFT JOIN filaments f ON f.id = u.filament_id
        ORDER BY u.created_at DESC
        LIMIT 200
    `).all();
    return json(results);
}

export async function onRequestPost(context) {
    const data = await context.request.json();
    const { filament_id, grams, project } = data;

    if (!filament_id || !grams || grams <= 0) {
        return json({ error: 'filament_id and grams are required' }, 400);
    }

    const db = context.env.DB;

    // Check current weight
    const spool = await db.prepare("SELECT weight_current FROM filaments WHERE id = ?")
        .bind(filament_id).first();

    if (!spool) return json({ error: 'Spool not found' }, 404);
    if (spool.weight_current < grams) {
        return json({ error: 'Not enough filament on spool' }, 400);
    }

    await db.batch([
        db.prepare(
            "UPDATE filaments SET weight_current = weight_current - ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(grams, filament_id),
        db.prepare(
            "INSERT INTO usage_logs (filament_id, project_name, weight_used) VALUES (?, ?, ?)"
        ).bind(filament_id, project ?? 'Manual', grams),
    ]);

    return json({ ok: true });
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

/**
 * DELETE /api/usage/:id
 * Body: { restore: true }  → adds grams back to the spool before deleting the log entry
 * Body: { restore: false } → deletes log entry only, filament weight unchanged
 */
export async function onRequestDelete(context) {
    const url = new URL(context.request.url);
    const id = url.pathname.split('/').pop();
    if (!id || isNaN(parseInt(id))) return json({ error: 'Invalid id' }, 400);

    const db = context.env.DB;

    // Fetch the log entry so we know which spool and how many grams
    const entry = await db.prepare(
        "SELECT filament_id, weight_used FROM usage_logs WHERE id = ?"
    ).bind(parseInt(id)).first();

    if (!entry) return json({ error: 'Log entry not found' }, 404);

    let restore = false;
    try {
        const body = await context.request.json();
        restore = !!body.restore;
    } catch { /* no body is fine, default restore = false */ }

    const ops = [
        db.prepare("DELETE FROM usage_logs WHERE id = ?").bind(parseInt(id))
    ];

    if (restore && entry.filament_id) {
        ops.push(
            db.prepare(
                "UPDATE filaments SET weight_current = weight_current + ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?"
            ).bind(entry.weight_used, entry.filament_id)
        );
    }

    await db.batch(ops);
    return json({ ok: true, restored: restore });
}
