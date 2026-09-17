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
        case"transcript.user":handlers.onUserTranscriptFinal(e.text);break;
        case"transcript.agent":handlers.onAgentTranscriptFinal(e.text);break;
        case"tool.call":handlers.onToolCall(e.call_id,e.name,e.arguments??{});break;
        case"reply.done":
          if(e.status!=="interrupted"){
            const pending=this.pendingToolResults.splice(0);
            for(const item of pending)this.send({type:"tool.result",call_id:item.callId,result:typeof item.result==="string"?item.result:JSON.stringify(item.result),is_error:item.isError});
          }else{this.pendingToolResults=[];}
          break;
        case"session.error":{const message=`${e.code??"session.error"}: ${e.message??"Unknown AssemblyAI error"}`;handlers.onError(message);this.rejectReady?.(new Error(message));this.resolveReady=null;this.rejectReady=null;break;}
        case"session.ended":handlers.onEnded();break;
      }
    });
    ws.on("error",err=>{handlers.onError(String(err));this.rejectReady?.(err instanceof Error?err:new Error(String(err)));this.resolveReady=null;this.rejectReady=null;});
    ws.on("close",()=>handlers.onEnded());
    return this.readyPromise;
  }

  sendAudioChunk(audio:string){this.send({type:"input.audio",audio});}
  updateSystemPrompt(systemPrompt:string){this.send({type:"session.update",session:{system_prompt:systemPrompt}});}
  updateTools(tools:unknown[]){this.send({type:"session.update",session:{tools}});}
  sendToolResult(callId:string,result:unknown,isError=false){this.pendingToolResults.push({callId,result,isError});}
  requestReply(instructions?:string){this.send(instructions?{type:"reply.create",instructions}:{type:"reply.create"});}
  end(){if(this.ws?.readyState===WebSocket.OPEN)this.send({type:"session.end"});this.ws?.close();this.ws=null;this.pendingToolResults=[];}
  private send(payload:unknown){if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(payload));}
}
