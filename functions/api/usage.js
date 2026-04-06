export async function onRequestPost(context) {
    const { filament_id, used, project } = await context.request.json();

    // 1. Log the history
    await context.env.DB.prepare(
        "INSERT INTO usage_logs (filament_id, project_name, weight_used) VALUES (?, ?, ?)"
    ).bind(filament_id, project, used).run();

    // 2. Subtract from the main spool
    await context.env.DB.prepare(
        "UPDATE filaments SET weight_current = weight_current - ? WHERE id = ?"
    ).bind(used, filament_id).run();

    return new Response("Weight Updated", { status: 200 });
}