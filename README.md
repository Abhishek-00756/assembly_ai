# Insuranos — Hands-Free Accident Claim Agent

Insuranos is an AssemblyAI Voice Agent-powered First Notice of Loss (FNOL) assistant for people who may be stressed, injured, or unable to type after a vehicle accident.

The core product rule is preserved: the LLM is never the source of truth. Claim facts are written through narrow tools into server-owned state; the completeness engine determines what remains. The browser renders state and does not arbitrarily edit claim fields.

## Demo flow

1. Enter name + email in Demo Mode.
2. Start the voice session.
3. Safety is checked first.
4. The agent gathers incident, vehicle, other-party and policy details one question at a time.
5. Unavailable facts can be explicitly marked unknown.
6. Evidence photos are requested through the browser camera/file picker.
7. The claim is read back for confirmation.
8. An insurer-ready JSON summary and PDF are generated; email is attempted when Resend is configured.

The eight phases are: Opening & Safety → Grounding & Consent → Incident Narrative → Structured Data Gathering → Photo/Evidence Guidance → Review & Confirmation → Output Generation → Next Steps & Closing.

## Implementation

- `packages/schema`: ClaimSchema, requirement tiers, completeness engine.
- `orchestrator`: persistent Node/TypeScript voice orchestrator, tool registry, state machine, safety guardrails, report/PDF/email pipeline, AssemblyAI adapter.
- `web`: Next.js PWA with identity, live captions, progress, completeness, photo capture and report delivery UI.
- `db/schema.sql`: Supabase Postgres schema for cloud mode.
- `DEMO.md`: judge-friendly walkthrough and test script.

### Demo/local persistence

The original scaffold mixed an in-memory orchestrator store with Supabase-only REST routes. This build adds `REPOSITORY_MODE=local`, a JSON-backed repository shared by the orchestrator and Next.js, so the live demo can run end-to-end without a Supabase project.

### AssemblyAI integration

AssemblyAI's Voice Agent API is used as the real-time voice layer. The adapter connects to `wss://agents.assemblyai.com/v1/ws`, sends a `session.update`, streams PCM audio, handles `tool.call`, returns `tool.result`, and requests replies when server-side actions complete.

### Action-oriented behavior

The agent is not a transcription machine. It calls typed actions such as `record_incident_basics`, `record_vehicle_damage`, `request_photo_upload`, `mark_field_unknown`, `generate_report`, `send_report_email`, and `escalate_safety_concern`. The server—not the model—controls phase transitions through explicit actions like `confirm_continue`, `finish_evidence_capture`, and `confirm_claim_summary`.

### Safety and edge cases

Prompt and tool behavior cover injury/ongoing danger, unsafe photo capture, unknown facts, corrections, uncertain identifiers, inability to continue, and avoiding fault/legal/coverage determinations.

## Run locally

Node 20+ recommended.

```bash
npm install
```

Terminal 1:

```bash
cd orchestrator
cp .env.example .env
# add ASSEMBLYAI_API_KEY
npm run dev
```

Terminal 2:

```bash
cd web
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

For local demo mode use `REPOSITORY_MODE=local` and `INSURANOS_LOCAL_DATA_DIR=../.localdata` in both apps.

## Optional cloud mode

Set `REPOSITORY_MODE=supabase`, configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, run `db/schema.sql`, and create private `evidence` and `reports` Storage buckets.

## Optional email

Set `RESEND_API_KEY` and `REPORT_FROM_EMAIL`. The report still generates when Resend is absent; only delivery is skipped/fails gracefully.

## Boundary

This is an FNOL intake assistant, not a fault adjudicator, legal advisor, medical triage system, or insurer coverage decision engine.
