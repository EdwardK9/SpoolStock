/**
 * Usage API
 *   GET          /api/usage          → all usage entries
 *   DELETE       /api/usage/:id      → delete a log entry (optionally restore filament)
 */

const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    });

/* GET – fetch all usage logs */
export async function onRequestGet({ env }) {
    const { results } = await env.DB.prepare(
        `SELECT ul.*, f.brand, f.material, f.color_name, f.style,
            (f.brand || ' ' || f.color_name || COALESCE(' ' || f.style, '')) AS filament_label
     FROM usage_logs ul
     LEFT JOIN filaments f ON ul.filament_id = f.id
     ORDER BY ul.created_at DESC`
    ).all();
    return json(results);
}

/* DELETE – remove a log entry; restore filament weight when requested */
export async function onRequestDelete({ env, request, url }) {
    const id = Number(url.pathname.split("/").pop());
    if (!id) return json({ error: "Invalid id" }, 400);

    let restore = false;
    try {
        const body = await request.json();
        restore = !!body.restore;
    } catch {
        // No body → treat as no‑restore request
        restore = false;
    }

    // Fetch the entry first to know the weight & filament
    const entry = await env.DB
        .prepare("SELECT filament_id, weight_used FROM usage_logs WHERE id = ?")
        .bind(id)
        .first();

    if (!entry) return json({ error: "Log entry not found" }, 404);

    const ops = [
        env.DB.prepare("DELETE FROM usage_logs WHERE id = ?").bind(id),
    ];

    if (restore && entry.filament_id) {
        ops.push(
            env.DB
                .prepare(
                    "UPDATE filaments SET weight_current = weight_current + ? WHERE id = ?"
                )
                .bind(entry.weight_used, entry.filament_id)
        );
    }

    try {
        await env.DB.batch(ops);
        return json({ ok: true, restored: restore });
    } catch (e) {
        console.error("Failed to delete usage entry:", e);
        return json({ error: "Deletion failed" }, 500);
    }
}
