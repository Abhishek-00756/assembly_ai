import { ClaimData } from "@insuranos/schema";
export const PHASES=["opening_safety","grounding_consent","narrative","structured_gathering","evidence","review","output_generation","closing"] as const;
export type Phase=typeof PHASES[number];
export type SessionStatus="in_progress"|"paused"|"review"|"completed";
export type AuthMode="otp"|"demo";
export interface Claimant{id:string;auth_mode:AuthMode;phone_number:string|null;display_name:string|null;email:string|null;created_at:string}
export interface ClaimSession{id:string;claimant_id:string;status:SessionStatus;current_phase:Phase;claim_data:ClaimData;requires_followup:boolean;started_at:string;last_active_at:string;completed_at:string|null}
export interface ReportArtifact{id:string;session_id:string;report_json:unknown|null;summary_text:string|null;pdf_url:string|null;emailed_to:string|null;emailed_at:string|null;email_status:"pending"|"sent"|"failed"|null}
export type SessionEventType="phase_transition"|"tool_call"|"safety_escalation"|"completeness_loop_warning";
export interface SessionEvent{id:string;session_id:string;event_type:SessionEventType;payload:Record<string,unknown>;at:string}
export type OrchestratorToClientEvent={type:"audio_out";audio:string}|{type:"transcript_partial"|"transcript_final";text:string;speaker:"user"|"agent"}|{type:"phase_update";phase:Phase}|{type:"completeness_update";completeness:import("@insuranos/schema").CompletenessResult}|{type:"photo_requested";photo_type:string}|{type:"session_paused"}|{type:"session_resumed"}|{type:"report_ready";report_url:string}|{type:"error";message:string};
export type ClientToOrchestratorEvent={type:"audio_chunk";audio:string}|{type:"client_event";event:"mute"|"resume"|"end_call"}|{type:"photo_uploaded";photo_type:string;storage_path:string};
