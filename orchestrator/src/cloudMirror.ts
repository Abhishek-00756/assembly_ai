import { createClient } from "@supabase/supabase-js";
import { ClaimSession, Claimant } from "./types";

export class CloudMirror{
 private client=process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY?createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}):null;
 get enabled(){return process.env.REPOSITORY_MODE==="supabase"&&!!this.client}
 async sync(claimant:Claimant,session:ClaimSession){
  if(!this.client)return;
  await this.client.from("claimants").upsert({id:claimant.id,auth_mode:claimant.auth_mode,phone_number:claimant.phone_number,display_name:claimant.display_name,email:claimant.email},{onConflict:"id"}).throwOnError();
  await this.client.from("claim_sessions").upsert({id:session.id,claimant_id:session.claimant_id,incident_group_id:session.incident_group_id,status:session.status,current_phase:session.current_phase,claim_data:session.claim_data,requires_followup:session.requires_followup,started_at:session.started_at,last_active_at:session.last_active_at,completed_at:session.completed_at},{onConflict:"id"}).throwOnError();
 }
 async groupSessions(groupId:string){
  if(!this.client)return[];
  const {data,error}=await this.client.from("claim_sessions").select("id,claimant_id,incident_group_id,status,current_phase,claim_data,requires_followup,started_at,last_active_at,completed_at").eq("incident_group_id",groupId);
  if(error)throw error;
  return(data??[]) as ClaimSession[];
 }
}
