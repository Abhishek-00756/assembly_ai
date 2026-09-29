import {NextResponse} from "next/server";

export async function GET(_req:Request,{params}:{params:{id:string}}){
  const base=(process.env.ORCHESTRATOR_HTTP_URL??"http://localhost:8787").replace(/\/$/,"");
  const upstream=await fetch(`${base}/api/sessions/${encodeURIComponent(params.id)}/report`,{method:"GET",headers:{"Content-Type":"application/json"},cache:"no-store"});
  const text=await upstream.text();
  return new NextResponse(text,{status:upstream.status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
}
