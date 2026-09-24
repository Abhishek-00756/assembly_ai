import { ClaimData, emptyClaimData, PhotoType, UNKNOWN_VALUE_SENTINEL } from "@insuranos/schema";
import { AuthMode, Claimant, ClaimSession, Phase, ReportArtifact, SessionStatus } from "../types";
import { IClaimRepository } from "./IClaimRepository";
import { mutateDb, readDb, randomUUID } from "../localDb";
export class JsonFileClaimRepository implements IClaimRepository{
 async createClaimant(input:{auth_mode:AuthMode;phone_number?:string;display_name?:string;email?:string}){return mutateDb(db=>{const c={id:randomUUID(),auth_mode:input.auth_mode,phone_number:input.phone_number??null,display_name:input.display_name??null,email:input.email??null,created_at:new Date().toISOString()};db.claimants.push(c);return c})}
 async findClaimantByPhone(phone:string){return readDb().claimants.find(c=>c.phone_number===phone)??null}
 async createSession(claimant_id:string){
  return mutateDb(db=>{
    const now=new Date().toISOString();
    const claimant=db.claimants.find(c=>c.id===claimant_id);
    const claimData=emptyClaimData();
    claimData.policy_info.contact_email=claimant?.email??null;
    const s:ClaimSession={
      id:randomUUID(),
      claimant_id,
      status:"in_progress",
      current_phase:"opening_safety",
      claim_data:claimData,
      requires_followup:false,
      started_at:now,
      last_active_at:now,
      completed_at:null
    };
    db.claim_sessions.push(s);
    return s;
  })
 }
 async findActiveSession(id:string){return readDb().claim_sessions.filter(s=>s.claimant_id===id&&["in_progress","paused","review"].includes(s.status)).sort((a,b)=>String(b.last_active_at).localeCompare(String(a.last_active_at)))[0]??null}
 async getSession(id:string){return readDb().claim_sessions.find(s=>s.id===id)??null}
 async writeFieldGroup<K extends keyof ClaimData>(id:string,group:K,value:ClaimData[K]){return mutateDb(db=>{const s=this.must(db,id);s.claim_data={...s.claim_data,[group]:value};s.last_active_at=new Date().toISOString();return s})}
 async markFieldUnknown(id:string,path:string){return mutateDb(db=>{const s=this.must(db,id);const c=structuredClone(s.claim_data);setAtPath(c as any,path,UNKNOWN_VALUE_SENTINEL);s.claim_data=c;s.last_active_at=new Date().toISOString();return s})}
 async appendPhoto(id:string,type:PhotoType,storage_path:string){return mutateDb(db=>{const s=this.must(db,id);s.claim_data.evidence.photos.push({photo_type:type,storage_path,uploaded_at:new Date().toISOString()});s.last_active_at=new Date().toISOString();return s})}
 async setPhase(id:string,phase:Phase){return this.patch(id,s=>{s.current_phase=phase})}
 async setStatus(id:string,status:SessionStatus){return this.patch(id,s=>{s.status=status;if(status==="completed")s.completed_at=new Date().toISOString()})}
 async setRequiresFollowup(id:string,v:boolean){return this.patch(id,s=>{s.requires_followup=v})}
 async createReportArtifact(id:string,data:Partial<ReportArtifact>){return mutateDb(db=>{const r:ReportArtifact={id:randomUUID(),session_id:id,report_json:null,summary_text:null,pdf_url:null,emailed_to:null,emailed_at:null,email_status:null,...data};db.report_artifacts=db.report_artifacts.filter(x=>x.session_id!==id);db.report_artifacts.push(r);return r})}
 async updateReportArtifact(id:string,patch:Partial<ReportArtifact>){return mutateDb(db=>{const r=db.report_artifacts.find(x=>x.session_id===id);if(!r)throw new Error(`No ReportArtifact for session ${id}`);Object.assign(r,patch);return r})}
 async getReportArtifact(id:string){return readDb().report_artifacts.find(r=>r.session_id===id)??null}
 async logEvent(id:string,event_type:string,payload:Record<string,unknown>){mutateDb(db=>{db.session_event_log.push({id:randomUUID(),session_id:id,event_type,payload,at:new Date().toISOString()})})}
 private patch(id:string,fn:(s:ClaimSession)=>void){return mutateDb(db=>{const s=this.must(db,id);fn(s);s.last_active_at=new Date().toISOString();return s})}
 private must(db:any,id:string){const s=db.claim_sessions.find((x:any)=>x.id===id);if(!s)throw new Error(`No ClaimSession ${id}`);return s as ClaimSession}
}
function setAtPath(obj:any,path:string,value:unknown){const parts=path.replace(/\[(\d+)\]/g,".$1").split(".");let cur=obj;for(let i=0;i<parts.length-1;i++){const p=parts[i];if(cur[p]==null)cur[p]=/^\d+$/.test(parts[i+1])?[]:{};cur=cur[p]}cur[parts[parts.length-1]]=value}
