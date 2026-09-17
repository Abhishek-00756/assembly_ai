import {NextResponse} from "next/server";

export async function POST(req:Request){
  const base=(process.env.ORCHESTRATOR_HTTP_URL??"http://localhost:8787").replace(/\/$/,"");
  const body=await req.json();
  const upstream=await fetch(`${base}/api/sessions/demo`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store"});
  const text=await upstream.text();
  return new NextResponse(text,{status:upstream.status,headers:{"Content-Type":"application/json"}});
}
