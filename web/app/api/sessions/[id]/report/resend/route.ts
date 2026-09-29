import {NextResponse} from "next/server";

export async function POST(_req:Request,{params}:{params:{id:string}}){
  const base=(process.env.ORCHESTRATOR_HTTP_URL??"http://localhost:8787").replace(/\/$/,"");
  const upstream=await fetch(`${base}/api/sessions/${encodeURIComponent(params.id)}/report/resend`,{method:"POST",headers:{"Content-Type":"application/json"}});
  const text=await upstream.text();
  return new NextResponse(text,{status:upstream.status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
}
