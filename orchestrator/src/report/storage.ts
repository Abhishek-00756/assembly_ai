import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs/promises";

export async function uploadPdf(sessionId:string,pdfBuffer:Buffer){
  const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url||!key){
    const dir=path.resolve(process.env.INSURANOS_LOCAL_DATA_DIR??".localdata","reports");
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,`${sessionId}.pdf`),pdfBuffer);
    const base=(process.env.PUBLIC_ORCH_BASE_URL??`http://localhost:${process.env.ORCHESTRATOR_PORT??8787}`).replace(/\/$/,"");
    return `${base}/api/sessions/${sessionId}/report/download`;
  }
  const db=createClient(url,key,{auth:{persistSession:false}});
  const objectPath=`${sessionId}/${Date.now()}.pdf`;
  const up=await db.storage.from("reports").upload(objectPath,pdfBuffer,{contentType:"application/pdf",upsert:true});
  if(up.error)throw up.error;
  const signed=await db.storage.from("reports").createSignedUrl(objectPath,3600);
  if(signed.error)throw signed.error;
  return signed.data.signedUrl;
}
