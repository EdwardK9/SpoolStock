
export async function onRequestPost(context){

const data=await context.request.json()

await context.env.DB.batch([
context.env.DB.prepare(
"UPDATE filaments SET weight_current=weight_current-? WHERE id=?"
).bind(data.grams,data.id),

context.env.DB.prepare(
"INSERT INTO usage_logs (filament_id,project_name,weight_used) VALUES (?,?,?)"
).bind(data.id,data.project,data.grams)
])

return new Response(JSON.stringify({ok:true}))
}
