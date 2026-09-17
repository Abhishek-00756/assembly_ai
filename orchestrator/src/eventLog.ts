import { IClaimRepository } from "./repository/IClaimRepository";
export class EventLog{
 constructor(private repo:IClaimRepository){}
 async phase(sessionId:string,to:string){await this.repo.logEvent(sessionId,"phase_transition",{to})}
 async toolCall(sessionId:string,name:string,ok:boolean,fields:string[]){await this.repo.logEvent(sessionId,"tool_call",{tool:name,success:ok,fields})}
 async safety(sessionId:string,reason:string){await this.repo.logEvent(sessionId,"safety_escalation",{reason})}
 async loopWarning(sessionId:string){await this.repo.logEvent(sessionId,"completeness_loop_warning",{})}
}
