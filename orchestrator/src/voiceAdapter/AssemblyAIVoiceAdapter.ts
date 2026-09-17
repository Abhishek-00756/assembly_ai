import WebSocket from "ws";
import { IVoiceSessionAdapter, VoiceSessionConfig, VoiceSessionHandlers } from "./IVoiceSessionAdapter";
const ASSEMBLYAI_WS_URL="wss://agents.assemblyai.com/v1/ws";
export class AssemblyAIVoiceAdapter implements IVoiceSessionAdapter{
 private ws:WebSocket|null=null; private handlers:VoiceSessionHandlers|null=null;
 constructor(private apiKey:string=process.env.ASSEMBLYAI_API_KEY!){if(!this.apiKey)throw new Error("ASSEMBLYAI_API_KEY missing — see orchestrator/.env.example");}
 connect(config:VoiceSessionConfig,handlers:VoiceSessionHandlers):Promise<void>{this.handlers=handlers;return new Promise((resolve,reject)=>{const ws=new WebSocket(ASSEMBLYAI_WS_URL,{headers:{Authorization:`Bearer ${this.apiKey}`}});this.ws=ws;ws.on("open",()=>{this.send({type:"session.update",session:{system_prompt:config.systemPrompt,greeting:config.greeting,input:{format:{encoding:"audio/pcm"}},output:{format:{encoding:"audio/pcm"},voice:"alba"},tools:config.tools}});});ws.on("message",raw=>{let e:any;try{e=JSON.parse(raw.toString())}catch{return}switch(e.type){case"session.ready":resolve();break;case"reply.audio":handlers.onAudioOut(e.data);break;case"transcript.user.delta":handlers.onUserTranscriptPartial(e.text);break;case"transcript.user":handlers.onUserTranscriptFinal(e.text);break;case"transcript.agent":handlers.onAgentTranscriptFinal(e.text);break;case"tool.call":handlers.onToolCall(e.call_id,e.name,e.arguments??{});break;case"session.error":handlers.onError(`${e.code}: ${e.message}`);break;case"session.ended":handlers.onEnded();break;}});ws.on("error",err=>{handlers.onError(String(err));reject(err)});ws.on("close",()=>handlers.onEnded());});}
 sendAudioChunk(audio:string){this.send({type:"input.audio",audio});}
 updateSystemPrompt(systemPrompt:string){this.send({type:"session.update",session:{system_prompt:systemPrompt}});}
 updateTools(tools:unknown[]){this.send({type:"session.update",session:{tools}});}
 sendToolResult(callId:string,result:unknown,isError=false){this.send({type:"tool.result",call_id:callId,result:typeof result==="string"?result:JSON.stringify(result),is_error:isError});}
 requestReply(instructions?:string){this.send({type:"reply.create",instructions});}
 end(){this.send({type:"session.end"});this.ws?.close();}
 private send(payload:unknown){if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(payload));}
}
