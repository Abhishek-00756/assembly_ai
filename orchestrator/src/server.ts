import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { computeCompleteness, PhotoTypeEnum } from "@insuranos/schema";
import { IClaimRepository } from "./repository/IClaimRepository";
import { JsonFileClaimRepository } from "./repository/JsonFileClaimRepository";
import { AssemblyAIVoiceAdapter } from "./voiceAdapter/AssemblyAIVoiceAdapter";
import { IVoiceSessionAdapter } from "./voiceAdapter/IVoiceSessionAdapter";
import { toolsForPhase, toAssemblyAIToolSchema } from "./tools/registry";
import { callTool } from "./tools/handlers";
import { checkPhaseAdvance, advancePhase } from "./stateMachine";
import { buildSystemPrompt, resumeGroundingMessage } from "./promptBuilder";
import { CompletenessLoopGuard } from "./completenessLoopGuard";
import { EventLog } from "./eventLog";
import { buildIncidentLocation, reverseGeocode, verifyPhoto } from "./phase1";
import { enrichContext } from "./riskEngine";
import { GraphStore } from "./graphStore";
import { CloudMirror } from "./cloudMirror";
import { CrossInsurerService } from "./crossInsurer";
import { ClientToOrchestratorEvent, OrchestratorToClientEvent, Phase } from "./types";

const PORT = Number(process.env.ORCHESTRATOR_PORT ?? 8787);
const repo: IClaimRepository = new JsonFileClaimRepository();
const eventLog = new EventLog(repo);
const loopGuard = new CompletenessLoopGuard();
const localDataDir = path.resolve(process.env.INSURANOS_LOCAL_DATA_DIR ?? ".localdata");
const graphStore = new GraphStore();
const cloudMirror = new CloudMirror();
const crossInsurer = new CrossInsurerService(cloudMirror, graphStore);
const GRAPH_WRITE_TOOLS = new Set(["record_safety_status","record_incident_basics","record_other_party","record_vehicle_damage","record_evidence","record_policyholder_info","mark_field_unknown"]);

const PROGRESS_TOOLS = new Set([
  "record_safety_status",
  "record_incident_basics",
  "record_other_party",
  "record_vehicle_damage",
  "record_evidence",
  "record_policyholder_info",
  "mark_field_unknown",
]);

interface ActiveCall {
  clientWs: WebSocket;
  voice: IVoiceSessionAdapter;
  sessionId: string;
  escalationActive: boolean;
}

function sendToClient(client: WebSocket, event: OrchestratorToClientEvent) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
}

async function syncDerivedState(sessionId:string,sourceTool:string){
  const session=await repo.getSession(sessionId);
  if(!session)return[] as string[];
  let conflicts:string[]=[];
  try{conflicts=await graphStore.syncSession(session,sourceTool)}catch(error){await eventLog.toolCall(sessionId,"knowledge_graph_sync",false,[])}
  try{
    const claimant=await repo.getClaimant(session.claimant_id);
    if(claimant&&cloudMirror.enabled)await cloudMirror.sync(claimant,session);
  }catch{await eventLog.toolCall(sessionId,"cloud_mirror_sync",false,[])}
  if((sourceTool==="record_incident_basics"||sourceTool==="device_gps")&&session.claim_data.incident_location&&session.claim_data.incident.date_time){
    try{const context=await enrichContext(session);if(context)await repo.writeFieldGroup(sessionId,"context_factors",context)}catch{await eventLog.toolCall(sessionId,"risk_context_enrichment",false,[])}
  }
  return conflicts;
}

async function reconcileAtReview(call:ActiveCall){
  const session=await repo.getSession(call.sessionId);
  if(!session)return;
  try{
    const result=await crossInsurer.reconcile(session);
    await repo.writeFieldGroup(call.sessionId,"cross_party_context",{incident_group_id:session.incident_group_id,related_session_count:result.related_session_count,grounded_narrative:result.grounded_narrative,conflicts:result.conflicts,checked_at:new Date().toISOString()});
    sendToClient(call.clientWs,{type:"cross_insurer_update",related_session_count:result.related_session_count,conflicts:result.conflicts,grounded_narrative:result.grounded_narrative});
    if(result.conflicts.length)call.voice.requestReply("A cross-party consistency check found conflicting claim details. Ask the caller to clarify the following before confirmation: "+result.conflicts.join("; ")+". Do not decide which party is correct.");
  }catch(error){await eventLog.toolCall(call.sessionId,"cross_insurer_reconcile",false,["error"])}
}

async function pushPhaseTools(call: ActiveCall) {
  const session = await repo.getSession(call.sessionId);
  if (!session) return;
  const tools = toAssemblyAIToolSchema(toolsForPhase(session.current_phase));
  call.voice.updateTools(tools);
  call.voice.updateSystemPrompt(buildSystemPrompt(session.current_phase, call.escalationActive));
  sendToClient(call.clientWs, { type: "phase_update", phase: session.current_phase });
  sendToClient(call.clientWs, { type: "completeness_update", completeness: computeCompleteness(session.claim_data) });
}

async function transitionAfterTool(call: ActiveCall, name: string, failed: boolean) {
  const session = await repo.getSession(call.sessionId);
  if (!session) return;

  let next: Phase | null = await checkPhaseAdvance(repo, call.sessionId, name, failed);

  if (name === "confirm_continue" && !failed && session.current_phase === "grounding_consent") next = "narrative";
  if (name === "finish_evidence_capture" && !failed && session.current_phase === "evidence") next = "review";
  if (name === "confirm_claim_summary" && !failed && session.current_phase === "review") next = "output_generation";

  if (next) {
    await advancePhase(repo, call.sessionId, next);
    await pushPhaseTools(call);
    if (next === "output_generation") call.voice.requestReply("The caller confirmed the claim summary. Generate the report now.");
  }
}

async function handleToolCall(call: ActiveCall, callId: string, name: string, args: Record<string, unknown>) {
  if (name === "get_field_completeness") {
    const nudge = loopGuard.onCompletenessCall(call.sessionId);
    if (nudge) {
      await eventLog.loopWarning(call.sessionId);
      call.voice.requestReply(nudge);
    }
  } else if (PROGRESS_TOOLS.has(name)) {
    loopGuard.onProgressWrite(call.sessionId);
  }

  if (name === "escalate_safety_concern") call.escalationActive = true;

  try {
    const result = await callTool(name, args, { repo, sessionId: call.sessionId });
    await eventLog.toolCall(call.sessionId, name, result.ok, Object.keys(result.result));
    call.voice.sendToolResult(callId, result.result, !result.ok);

    const session = await repo.getSession(call.sessionId);
    if (session) {
      sendToClient(call.clientWs, { type: "completeness_update", completeness: computeCompleteness(session.claim_data) });
    }

    if (name === "request_photo_upload" && result.ok) {
      sendToClient(call.clientWs, { type: "photo_requested", photo_type: String(result.result.requested_photo_type) });
    }

    if (name === "generate_report" && result.ok) {
      const report = await repo.getReportArtifact(call.sessionId);
      if (report?.summary_text) sendToClient(call.clientWs, { type: "report_ready", report_url: report.pdf_url, summary_text: report.summary_text });
    }

    if (name === "escalate_safety_concern") await pushPhaseTools(call);
    await transitionAfterTool(call, name, !result.ok);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await eventLog.toolCall(call.sessionId, name, false, []);
    call.voice.sendToolResult(callId, { error: message }, true);
    sendToClient(call.clientWs, { type: "error", message });
  }
}

async function handleClientMessage(call: ActiveCall, raw: WebSocket.RawData) {
  let event: ClientToOrchestratorEvent;
  try {
    event = JSON.parse(raw.toString()) as ClientToOrchestratorEvent;
  } catch {
    return;
  }

  switch (event.type) {
    case "audio_chunk":
      call.voice.sendAudioChunk(event.audio);
      break;
    case "client_event":
      if (event.event === "end_call") {
        call.voice.end();
        await repo.setStatus(call.sessionId, "completed");
      } else if (event.event === "resume") {
        sendToClient(call.clientWs, { type: "session_resumed" });
      }
      break;
    case "photo_uploaded": {
      const parsedType = PhotoTypeEnum.safeParse(event.photo_type);
      if (!parsedType.success) return;
      call.voice.requestReply(`The caller's ${parsedType.data} photo was just received. Acknowledge that specific photo and continue.`);
      const session = await repo.getSession(call.sessionId);
      if (session) sendToClient(call.clientWs, { type: "completeness_update", completeness: computeCompleteness(session.claim_data) });
      break;
    }
  }
}

async function startCall(clientWs: WebSocket, sessionId: string) {
  const session = await repo.getSession(sessionId);
  if (!session) {
    sendToClient(clientWs, { type: "error", message: `No session ${sessionId}` });
    clientWs.close();
    return;
  }

  const voice = new AssemblyAIVoiceAdapter();
  const call: ActiveCall = { clientWs, voice, sessionId, escalationActive: session.requires_followup };
  const resuming = session.status === "paused";
  await repo.setStatus(sessionId, "in_progress");

  await voice.connect(
    {
      systemPrompt: buildSystemPrompt(session.current_phase, call.escalationActive),
      greeting: resuming
        ? "Welcome back — let's pick up right where we left off."
        : "Hi, I'm here to help you through your accident report. First, are you or anyone else hurt?",
      tools: toAssemblyAIToolSchema(toolsForPhase(session.current_phase)),
    },
    {
      onAudioOut: (audio) => sendToClient(clientWs, { type: "audio_out", audio }),
      onUserTranscriptPartial: (text) => sendToClient(clientWs, { type: "transcript_partial", text, speaker: "user" }),
      onUserTranscriptFinal: (text) => sendToClient(clientWs, { type: "transcript_final", text, speaker: "user" }),
      onAgentTranscriptFinal: (text) => sendToClient(clientWs, { type: "transcript_final", text, speaker: "agent" }),
      onToolCall: (callId, name, args) => void handleToolCall(call, callId, name, args),
      onError: (message) => sendToClient(clientWs, { type: "error", message }),
      onEnded: () => undefined,
    }
  );

  if (resuming) call.voice.requestReply(resumeGroundingMessage(computeCompleteness(session.claim_data)));
  await pushPhaseTools(call);
  clientWs.on("message", (raw) => void handleClientMessage(call, raw));
  clientWs.on("close", () => void onClientDisconnect(call));
}

async function onClientDisconnect(call: ActiveCall) {
  const session = await repo.getSession(call.sessionId);
  if (session && session.status !== "completed") await repo.setStatus(call.sessionId, "paused");
  call.voice.end();
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function httpHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "OPTIONS") return json(res, 204, null);

  try {
    if (req.method === "POST" && url.pathname === "/api/sessions/demo") {
      const body = await readJson(req);
      const claimant = await repo.createClaimant({
        auth_mode: "demo",
        display_name: typeof body.display_name === "string" ? body.display_name : undefined,
        email: typeof body.email === "string" ? body.email : undefined,
      });
      const session = await repo.createSession(claimant.id);
      return json(res, 201, { claimant, session });
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      const session = await repo.getSession(sessionMatch[1]);
      if (!session) return json(res, 404, { error: "session_not_found" });
      return json(res, 200, { session, completeness: computeCompleteness(session.claim_data), report: await repo.getReportArtifact(session.id) });
    }

    const locationMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/location$/);
    if (req.method === "POST" && locationMatch) {
      const body = await readJson(req);
      const latitude = typeof body.latitude === "number" ? body.latitude : Number(body.latitude);
      const longitude = typeof body.longitude === "number" ? body.longitude : Number(body.longitude);
      const accuracyValue = body.accuracy_m == null ? null : Number(body.accuracy_m);
      const accuracy = accuracyValue != null && Number.isFinite(accuracyValue) ? accuracyValue : null;
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return json(res, 400, { error: "valid latitude and longitude are required" });
      }
      const sessionId = locationMatch[1];
      const session = await repo.getSession(sessionId);
      if (!session) return json(res, 404, { error: "session_not_found" });
      const address = await reverseGeocode(latitude, longitude);
      const incidentLocation = buildIncidentLocation(latitude, longitude, accuracy, address);
      const updated = await repo.writeFieldGroup(sessionId, "incident_location", incidentLocation);
      const locationText = address ?? "GPS (" + latitude.toFixed(6) + ", " + longitude.toFixed(6) + ")";
      await repo.writeFieldGroup(sessionId, "incident", { ...updated.claim_data.incident, location: locationText });
      const latest = await repo.getSession(sessionId);
      return json(res, 200, { location: latest?.claim_data.incident_location ?? incidentLocation, address: locationText, completeness: latest ? computeCompleteness(latest.claim_data) : null });
    }

    if (req.method === "POST" && url.pathname === "/api/photos") {
      const body = await readJson(req);
      const sessionId = typeof body.session_id === "string" ? body.session_id : null;
      const photoTypeResult = typeof body.photo_type === "string" ? PhotoTypeEnum.safeParse(body.photo_type) : null;
      const dataUrl = typeof body.data_url === "string" ? body.data_url : null;
      if (!sessionId || !photoTypeResult?.success || !dataUrl) return json(res, 400, { error: "session_id, valid photo_type and data_url are required" });
      const session = await repo.getSession(sessionId);
      if (!session) return json(res, 404, { error: "session_not_found" });
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return json(res, 400, { error: "data_url must be a base64 data URL" });
      const buffer = Buffer.from(match[2], "base64");
      const verification = await verifyPhoto(buffer, session);
      const dir = path.join(localDataDir, "evidence", sessionId);
      await fs.mkdir(dir, { recursive: true });
      const safeType = photoTypeResult.data;
      const filename = Date.now() + "-" + safeType + ".jpg";
      const storagePath = "evidence/" + sessionId + "/" + filename;
      await fs.writeFile(path.join(dir, filename), buffer);
      const latest = await repo.getSession(sessionId);
      if (!latest) return json(res, 404, { error: "session_not_found" });
      const photos = [...latest.claim_data.evidence.photos, { photo_type: safeType, storage_path: storagePath, uploaded_at: new Date().toISOString(), verification }];
      const updated = await repo.writeFieldGroup(sessionId, "evidence", { ...latest.claim_data.evidence, photos });
      return json(res, 201, { storage_path: storagePath, photo_verification: verification, completeness: computeCompleteness(updated.claim_data) });
    }
    const downloadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/report\/download$/);
    if (req.method === "GET" && downloadMatch) {
      const file = path.join(localDataDir, "reports", `${downloadMatch[1]}.pdf`);
      try {
        const pdf = await fs.readFile(file);
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
        res.end(pdf);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Report not found");
      }
      return;
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

const httpServer = http.createServer((req, res) => { void httpHandler(req, res); });
const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (clientWs, req) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    sendToClient(clientWs, { type: "error", message: "session_id query param required" });
    clientWs.close();
    return;
  }
  void startCall(clientWs, sessionId).catch((err) => {
    sendToClient(clientWs, { type: "error", message: err instanceof Error ? err.message : String(err) });
    clientWs.close();
  });
});

httpServer.listen(PORT, () => console.log(`Insuranos orchestrator listening on http://localhost:${PORT} and ws://localhost:${PORT}`));
