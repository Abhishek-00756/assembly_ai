import fs from "node:fs/promises";
import path from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ClaimSession } from "./types";

export interface GraphEdge{id:string;session_id:string;incident_group_id:string;subject:string;relation:string;object_value:string;source_tool:string;created_at:string}
interface GraphFile{edges:GraphEdge[]}
const dataDir=path.resolve(process.env.INSURANOS_LOCAL_DATA_DIR??".localdata"),file=path.join(dataDir,"knowledge-graph.json");
const cloud=process.env.REPOSITORY_MODE==="supabase"&&process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase:SupabaseClient|null=cloud?createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}}):null;
async function localRead():Promise<GraphFile>{try{return JSON.parse(await fs.readFile(file,"utf8")) as GraphFile}catch{return{edges:[]}}}
async function localWrite(value:GraphFile){await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2),"utf8")}
function value(v:unknown){if(v==null||v==="")return null;return String(v)}
function edgesFromSession(s:ClaimSession,sourceTool:string):GraphEdge[]{
 const now=new Date().toISOString(),out:GraphEdge[]=[];const add=(subject:string,relation:string,v:unknown)=>{const x=value(v);if(!x||x==="__UNKNOWN__")return;out.push({id:crypto.randomUUID(),session_id:s.id,incident_group_id:s.incident_group_id,subject,relation,object_value:x,source_tool:sourceTool,created_at:now})};
 const c=s.claim_data;const id=s.id;
 add("incident:"+id,"occurred_at",c.incident.date_time);add("incident:"+id,"located_at",c.incident.location);add("incident:"+id,"description",c.incident.description_summary);add("incident:"+id,"weather_reported",c.incident.weather);add("incident:"+id,"road_condition_reported",c.incident.road_conditions);
 if(c.incident_location)add("incident:"+id,"gps_location",c.incident_location.latitude.toFixed(6)+","+c.incident_location.longitude.toFixed(6));
 add("vehicle:"+id,"make",c.user_vehicle.make);add("vehicle:"+id,"model",c.user_vehicle.model);add("vehicle:"+id,"plate",c.user_vehicle.plate);add("vehicle:"+id,"damage",c.user_vehicle.damage_description);add("vehicle:"+id,"drivable",c.user_vehicle.drivable);
 add("policy:"+id,"policyholder_name",c.policy_info.policyholder_name);add("policy:"+id,"policy_number",c.policy_info.policy_number);add("policy:"+id,"contact_phone",c.policy_info.contact_phone);add("policy:"+id,"contact_email",c.policy_info.contact_email);
 const p=c.other_parties[0];if(p){add("other_party:"+id,"name",p.name);add("other_party:"+id,"phone",p.phone);add("other_party:"+id,"insurer",p.insurer_name);add("other_party:"+id,"policy_number",p.policy_number);add("other_party:"+id,"vehicle",[value(p.vehicle.make),value(p.vehicle.model),value(p.vehicle.plate)].filter(Boolean).join(" / "))}
 c.evidence.photos.forEach((p,i)=>add("photo:"+id+":"+i,"photo_type",p.photo_type));
 return out
}
export class GraphStore{
 async syncSession(session:ClaimSession,sourceTool:string){
  const incoming=edgesFromSession(session,sourceTool);
  if(supabase){
   if(incoming.length){const rows=incoming.map(e=>({id:e.id,session_id:e.session_id,incident_group_id:e.incident_group_id,subject:e.subject,relation:e.relation,object_value:e.object_value,source_tool:e.source_tool,created_at:e.created_at}));await supabase.from("knowledge_graph_edges").upsert(rows,{onConflict:"session_id,subject,relation,object_value"}).throwOnError()}
  }else{
   const db=await localRead();for(const e of incoming){if(!db.edges.some(x=>x.session_id===e.session_id&&x.subject===e.subject&&x.relation===e.relation&&x.object_value===e.object_value))db.edges.push(e)}await localWrite(db)
  }
  return this.findConflicts(session.incident_group_id)
 }
 async edgesForGroup(groupId:string):Promise<GraphEdge[]>{
  if(supabase){const {data,error}=await supabase.from("knowledge_graph_edges").select("*").eq("incident_group_id",groupId);if(error)throw error;return (data??[]) as GraphEdge[]}
  return (await localRead()).edges.filter(e=>e.incident_group_id===groupId)
 }
 async findConflicts(groupId:string){
  const edges=await this.edgesForGroup(groupId),by=new Map<string,Set<string>>(),conflicts:string[]=[];
  for(const e of edges){const k=e.subject+"|"+e.relation;const set=by.get(k)??new Set<string>();set.add(e.object_value);by.set(k,set)}
  for(const [k,set] of by){if(set.size>1){const parts=k.split("|");conflicts.push(parts[0]+" has conflicting "+parts[1]+": "+Array.from(set).join(" vs "))}}
  return conflicts
 }
}
