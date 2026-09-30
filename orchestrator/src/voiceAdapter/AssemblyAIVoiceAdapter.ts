import WebSocket from "ws";
import { IVoiceSessionAdapter, VoiceSessionConfig, VoiceSessionHandlers } from "./IVoiceSessionAdapter";

const ASSEMBLYAI_WS_URL="wss://agents.assemblyai.com/v1/ws";

type PendingTool={callId:string;result:unknown;isError:boolean};

export class AssemblyAIVoiceAdapter implements IVoiceSessionAdapter{
  private ws:WebSocket|null=null;
  private handlers:VoiceSessionHandlers|null=null;
  private pendingToolResults:PendingTool[]=[];
  private readyPromise:Promise<void>|null=null;
  private resolveReady:(()=>void)|null=null;
  private rejectReady:((err:Error)=>void)|null=null;
  private watchdog:NodeJS.Timeout|null=null;
  private awaitingUser=true;

  /** Nudges the agent if it has been silent for a while, so a dropped turn cannot strand the caller. */
  private armWatchdog(){
   this.clearWatchdog();
   this.watchdog=setTimeout(()=>{
    if(this.awaitingUser)this.send({type:"reply.create",instructions:"The caller has not responded. Ask your next question again, briefly and in plain language."});
   },Number(process.env.SILENCE_NUDGE_MS??22000));
  }
  private clearWatchdog(){if(this.watchdog){clearTimeout(this.watchdog);this.watchdog=null}}

  constructor(private apiKey:string=process.env.ASSEMBLYAI_API_KEY!){
    if(!this.apiKey)throw new Error("ASSEMBLYAI_API_KEY missing — configure it as a server-side secret");
  }

  connect(config:VoiceSessionConfig,handlers:VoiceSessionHandlers):Promise<void>{
    this.handlers=handlers;
    this.readyPromise=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject});
    const ws=new WebSocket(ASSEMBLYAI_WS_URL,{headers:{Authorization:`Bearer ${this.apiKey}`}});
    this.ws=ws;
    ws.on("open",()=>{
      this.send({type:"session.update",session:{system_prompt:config.systemPrompt,greeting:config.greeting,output:{format:{encoding:"audio/pcm"},voice:"alba"},input:{format:{encoding:"audio/pcm"}},tools:config.tools}});
    });
    ws.on("message",raw=>{
      let e:any;try{e=JSON.parse(raw.toString())}catch{return}
      switch(e.type){
        case"session.ready":this.resolveReady?.();this.resolveReady=null;this.rejectReady=null;break;
        case"reply.audio":handlers.onAudioOut(e.data);break;
        case"transcript.user.delta":handlers.onUserTranscriptPartial(e.text);break;
        case"transcript.user":this.awaitingUser=false;this.clearWatchdog();handlers.onUserTranscriptFinal(e.text);break;
        case"transcript.agent":handlers.onAgentTranscriptFinal(e.text);break;
        case"tool.call":handlers.onToolCall(e.call_id,e.name,e.arguments??{});break;
        case"reply.done":
          // The agent has finished its turn and is now waiting on the caller.
          // Arm a watchdog so a dropped turn cannot leave the caller in silence.
          if(this.awaitingUser)this.armWatchdog();
          break;
        case"session.error":{const message=`${e.code??"session.error"}: ${e.message??"Unknown AssemblyAI error"}`;handlers.onError(message);this.rejectReady?.(new Error(message));this.resolveReady=null;this.rejectReady=null;break;}
        case"session.ended":this.clearWatchdog();handlers.onEnded();break;
      }
    });
    ws.on("error",err=>{this.clearWatchdog();handlers.onError(String(err));this.rejectReady?.(err instanceof Error?err:new Error(String(err)));this.resolveReady=null;this.rejectReady=null;});
    ws.on("close",()=>{this.clearWatchdog();handlers.onEnded()});
    return this.readyPromise;
  }

  sendAudioChunk(audio:string){this.send({type:"input.audio",audio});}
  /**
   * Type-to-talk fallback: inject the caller's typed reply as a user turn, then
   * explicitly request a reply. Injecting the message alone does not start a turn.
   * Verified against wss://agents.assemblyai.com/v1/ws: `content` must be a plain
   * string (a content array is rejected as an invalid message format).
   */
  sendUserText(text:string){
   const trimmed=text.trim();
   if(!trimmed)return;
   this.send({type:"conversation.message",role:"user",content:trimmed});
   this.send({type:"reply.create"});
  }
  updateSystemPrompt(systemPrompt:string){this.send({type:"session.update",session:{system_prompt:systemPrompt}});}
  updateTools(tools:unknown[]){this.send({type:"session.update",session:{tools}});}
  /**
   * Tool results are sent immediately rather than queued until reply.done.
   *
   * Previously results were buffered in pendingToolResults and flushed only on
   * reply.done. handleToolCall awaits real I/O (repo writes, Open-Meteo, graph
   * sync) before calling this, so any result finishing after reply.done was
   * silently discarded — the agent then waited forever on a result that never
   * arrived and went silent. Sending immediately removes that race entirely.
   */
  sendToolResult(callId:string,result:unknown,isError=false){
   this.send({type:"tool.result",call_id:callId,result:typeof result==="string"?result:JSON.stringify(result),is_error:isError});
  }
  requestReply(instructions?:string){this.send(instructions?{type:"reply.create",instructions}:{type:"reply.create"});}
  /**
   * Ends the remote session cleanly.
   *
   * Previously this sent session.end and closed the socket in the same tick, so
   * the frame was never flushed and AssemblyAI never acknowledged. It now sends
   * session.end, waits briefly for session.ended/close, then force-closes.
   * A handle is returned so the caller can await a confirmed end.
   */
  end():Promise<void>{
   this.clearWatchdog();
   if(!this.ws)return Promise.resolve();
   const ws=this.ws;
   this.ws=null;
   return new Promise<void>(resolve=>{
    let settled=false;
    const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);try{ws.close()}catch{};resolve()};
    const timer=setTimeout(finish,2000);
    try{
     ws.once("close",finish);
     ws.once("error",finish);
     if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:"session.end"}));
     else finish();
    }catch{finish()}
   });
  }
  private send(payload:unknown){if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(payload));}
}
