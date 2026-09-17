import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { computeCompleteness, PhotoType } from "@insuranos/schema";
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
import { ClientToOrchestratorEvent, OrchestratorToClientEvent, Phase } from "./types";

const PORT = Number(process.env.ORCHESTRATOR_PORT ?? 8787);
const repo: IClaimRepository = new JsonFileClaimRepository();
const eventLog = new EventLog(repo);
const loopGuard = new CompletenessLoopGuard();
const localDataDir = path.resolve(process.env.INSURANOS_LOCAL_DATA_DIR ?? ".localdata");

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
      if (report?.pdf_url) sendToClient(call.clientWs, { type: "report_ready", report_url: report.pdf_url });
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
      const photoType = event.photo_type as PhotoType;
      await repo.appendPhoto(call.sessionId, photoType, event.storage_path);
      call.voice.requestReply(`The caller's ${event.photo_type} photo was just received. Acknowledge that specific photo and continue.`);
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

    if (req.method === "POST" && url.pathname === "/api/photos") {
      const body = await readJson(req);
      const sessionId = typeof body.session_id === "string" ? body.session_id : null;
      const photoType = typeof body.photo_type === "string" ? body.photo_type : null;
      const dataUrl = typeof body.data_url === "string" ? body.data_url : null;
      if (!sessionId || !photoType || !dataUrl) return json(res, 400, { error: "session_id, photo_type and data_url are required" });
      const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
      if (!match) return json(res, 400, { error: "data_url must be a base64 data URL" });
      const dir = path.join(localDataDir, "evidence", sessionId);
      await fs.mkdir(dir, { recursive: true });
      const filename = `${Date.now()}-${photoType}.jpg`;
      const storagePath = `evidence/${sessionId}/${filename}`;
      await fs.writeFile(path.join(dir, filename), Buffer.from(match[1], "base64"));
      return json(res, 201, { storage_path: storagePath });
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
