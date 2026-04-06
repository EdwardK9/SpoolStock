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
// Add this to your usage.js API
export async function onRequestPost(context) {
    const data = await context.request.json();
    const db = context.env.DB;

    if (data.action === 'log_usage') {
        // ... existing log_usage code ...
    }

    if (data.action === 'delete_all') {
        await db.prepare("DELETE FROM usage_logs").run();
        return json({ ok: true, deleted: 'all' }, 200);
    }

    return json({ error: 'Unknown action' }, 400);
}
