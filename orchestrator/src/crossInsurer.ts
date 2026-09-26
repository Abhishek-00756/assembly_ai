import { ClaimSession } from "./types";
import { GraphStore } from "./graphStore";
import { CloudMirror } from "./cloudMirror";

export interface CrossPartyResult{related_session_count:number;conflicts:string[];grounded_narrative:string}
export class CrossInsurerService{
 constructor(private mirror:CloudMirror,private graph:GraphStore){}
 get enabled(){return this.mirror.enabled}
 async reconcile(session:ClaimSession):Promise<CrossPartyResult>{
  if(!this.enabled){
   const d=session.claim_data.incident.description_summary;
   return{related_session_count:1,conflicts:[],grounded_narrative:d&&d!=="__UNKNOWN__"?String(d):""};
  }
  const sessions=await this.mirror.groupSessions(session.incident_group_id);
  const usable=sessions.length?sessions:[session];
  const conflicts=await this.graph.findConflicts(session.incident_group_id);
  const narrative=usable.map((s,i)=>{
   const d=s.claim_data.incident.description_summary;
   const when=s.claim_data.incident.date_time;
   const where=s.claim_data.incident.location;
   const parts=[d&&d!=="__UNKNOWN__"?String(d):null,when&&when!=="__UNKNOWN__"?"Time: "+String(when):null,where&&where!=="__UNKNOWN__"?"Location: "+String(where):null].filter(Boolean) as string[];
   return"Party "+(i+1)+": "+parts.join(". ")+(parts.length?".":"");
  }).join(" ");
  return{related_session_count:usable.length,conflicts,grounded_narrative:narrative};
 }
}
