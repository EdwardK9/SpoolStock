/**
 * Inventory endpoint – thin wrapper for usage logging.
 *   GET  → list all filaments (same ordering as filaments API)
 *   POST → log a usage entry (single‑spool usage)
 */

const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    });

/* GET – current inventory */
export async function onRequestGet({ env }) {
    const { results } = await env.DB.prepare(
        "SELECT * FROM filaments ORDER BY material, brand, color_name"
    ).all();
    return json(results);
}

/* POST – log a usage entry (called from the UI) */
export async function onRequestPost({ env, request }) {
    const { filament_id, grams, project } = await request.json();

    if (!filament_id || !grams || grams <= 0) {
        return json({ error: "Invalid payload" }, 400);
    }

    await env.DB.batch([
        env.DB
            .prepare(
                "UPDATE filaments SET weight_current = weight_current - ? WHERE id = ?"
            )
            .bind(grams, filament_id),
        env.DB
            .prepare(
                "INSERT INTO usage_logs (filament_id, weight_used, project_name) VALUES (?, ?, ?)"
            )
            .bind(filament_id, grams, project ?? "Manual"),
    ]);

    return json({ ok: true });
}
