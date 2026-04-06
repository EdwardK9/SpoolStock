
export default {

async fetch(req, env){

const url=new URL(req.url)

if(url.pathname=="/api/auth"){

const body=await req.json()

if(body.password===env.APP_PASSWORD){
return new Response(JSON.stringify({ok:true}))
}

return new Response(JSON.stringify({ok:false}),{status:401})

}

return new Response("FilamentStock API")

}

}
