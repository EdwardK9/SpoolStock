/**
 * Cloudflare Pages Function: functions/api/usage/[id].js
 *
 * Handles requests to /api/usage/:id
 *
 * DELETE /api/usage/:id
 *   Body: { restore: true }  → adds grams back to the spool, then deletes the log entry
 *   Body: { restore: false } → deletes the log entry only, filament weight unchanged
 */

export async function onRequestDelete(context) {
    const id = parseInt(context.params.id);
    if (!id || isNaN(id)) return json({ error: 'Invalid id' }, 400);

    const db = context.env.DB;

    // Fetch the log entry so we know which spool and how many grams
    const entry = await db.prepare(
        "SELECT filament_id, weight_used FROM usage_logs WHERE id = ?"
    ).bind(id).first();

    if (!entry) return json({ error: 'Log entry not found' }, 404);

    let restore = false;
    try {
        const body = await context.request.json();
        restore = !!body.restore;
    } catch { /* no body or unparseable body — default restore = false */ }

    const ops = [
        db.prepare("DELETE FROM usage_logs WHERE id = ?").bind(id)
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

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        }
    });
}
