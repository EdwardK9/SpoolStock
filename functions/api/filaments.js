
export async function onRequestGet(context){
const {results}=await context.env.DB.prepare(
"SELECT * FROM filaments ORDER BY id DESC"
).all()

return new Response(JSON.stringify(results))
}
