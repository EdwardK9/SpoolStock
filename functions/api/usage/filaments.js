/**
 * Filament API
 *   GET    /api/filaments       → list all filaments
 *   POST   /api/filaments       → bulk_import | add_single
 *   PUT    /api/filaments/:id   → update a spool
 *   DELETE /api/filaments/:id   → delete a spool + its usage logs (atomic batch)
 */

const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    });

/* GET – all filaments */
export async function onRequestGet({ env }) {
    const { results } = await env.DB.prepare(
        "SELECT * FROM filaments ORDER BY material, brand, color_name"
    ).all();
    return json(results);
}

/* POST – bulk import or single insert */
export async function onRequestPost({ env, request }) {
    const payload = await request.json();
    const db = env.DB;

    if (payload.action === "bulk_import") {
        if (!Array.isArray(payload.items) || payload.items.length === 0) {
            return json({ error: "No items supplied" }, 400);
        }

        // Remove old data first
        await db.prepare("DELETE FROM filaments").run();

        const stmt = db.prepare(`
      INSERT INTO filaments
        (brand, material, color_name, style, code, barcode,
         web_address, weight_current, color_hex, total_purchased)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        const CHUNK = 90;
        for (let i = 0; i < payload.items.length; i += CHUNK) {
            const chunk = payload.items.slice(i, i + CHUNK);
            await db.batch(
                chunk.map((it) =>
                    stmt.bind(
                        it.brand ?? null,
                        it.material ?? null,
                        it.color_name ?? null,
                        it.style ?? null,
                        it.code ?? null,
                        it.barcode ?? null,
                        it.web_address ?? null,
                        it.weight_current ?? 1000,
                        it.color_hex ?? null,
                        it.total_purchased ?? null
                    )
                )
            );
        }
        return json({ ok: true, count: payload.items.length }, 201);
    }

    if (payload.action === "add_single") {
        const i = payload.item;
        const { meta } = await db
            .prepare(`
        INSERT INTO filaments (brand, material, color_name, style,
                               weight_current, color_hex, web_address)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
            .bind(
                i.brand ?? null,
                i.material ?? null,
                i.color_name ?? null,
                i.style ?? null,
                i.weight_current ?? 1000,
                i.color_hex ?? null,
                i.web_address ?? null
            )
            .run();
        return json({ ok: true, id: meta.last_row_id }, 201);
    }

    return json({ error: "Unsupported action" }, 400);
}

/* PUT – update an existing spool */
export async function onRequestPut({ env, request, url }) {
    const id = Number(url.pathname.split("/").pop());
    if (!id) return json({ error: "Invalid id" }, 400);

    const data = await request.json();
    await env.DB.prepare(`
    UPDATE filaments
    SET brand=?, material=?, color_name=?, style=?,
        weight_current=?, color_hex=?, web_address=?,
        last_updated=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(
        data.brand ?? null,
        data.material ?? null,
        data.color_name ?? null,
        data.style ?? null,
        data.weight_current ?? 1000,
        data.color_hex ?? null,
        data.web_address ?? null,
        id
    ).run();

    return json({ ok: true });
}

/* DELETE – remove spool and all its usage logs in a single batch */
export async function onRequestDelete({ env, url }) {
    const id = Number(url.pathname.split("/").pop());
    if (!id) return json({ error: "Invalid id" }, 400);

    try {
        await env.DB.batch([
            env.DB.prepare("DELETE FROM usage_logs WHERE filament_id = ?").bind(id),
            env.DB.prepare("DELETE FROM filaments WHERE id = ?").bind(id),
        ]);
        return json({ ok: true });
    } catch (e) {
        console.error("Failed to delete spool:", e);
        return json({ error: "Deletion failed" }, 500);
    }
}
