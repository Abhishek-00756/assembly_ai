# Insuranos — Hands-Free Accident Claim Agent

Insuranos is an AssemblyAI Voice Agent-powered First Notice of Loss (FNOL) assistant for people who may be stressed, injured, or unable to type after a vehicle accident.

The core product rule is preserved: the LLM is never the source of truth. Claim facts are written through narrow tools into server-owned state; the completeness engine determines what remains. The browser renders server state and does not arbitrarily edit claim fields.

## Demo flow

1. Enter a name and email in Demo Mode.
2. Start the voice session.
3. Safety is checked first.
4. The agent gathers incident, vehicle, other-party and policy details one question at a time.
5. Unavailable facts can be explicitly marked unknown.
6. Evidence photos can be requested through the browser camera/file picker.
7. The claim is read back for confirmation.
8. An insurer-ready JSON summary and PDF are generated; email delivery is attempted when Resend is configured.

The eight phases are:

**Opening & Safety → Grounding & Consent → Incident Narrative → Structured Data Gathering → Photo/Evidence Guidance → Review & Confirmation → Output Generation → Next Steps & Closing**

## Implementation

- `packages/schema`: ClaimSchema, requirement tiers and completeness engine.
- `orchestrator`: Node/TypeScript voice orchestrator, local persistence, tool registry, state machine, safety guardrails, report/PDF/email pipeline and AssemblyAI adapter.
- `web`: Next.js UI with identity, live captions, progress, completeness, photo capture and report delivery.
- `db/schema.sql`: Supabase Postgres schema for cloud mode.
- `DEMO.md`: judge-friendly walkthrough and test script.

### Server-owned state

The LLM is not the system of record. The orchestrator writes claim facts through narrow tools into a server-owned ClaimSession. The completeness engine determines which fields remain missing, and the state machine controls phase transitions.

### Demo/local persistence

Set `REPOSITORY_MODE=local` to use the JSON-backed repository. This allows the demo to run without a Supabase project.

Local state is stored under:

```
.localdata/
├── insuranos.json
├── evidence/<session-id>/
└── reports/<session-id>.pdf
```

The `.localdata` directory is runtime data and should not be committed to Git.

### AssemblyAI integration

AssemblyAI's Voice Agent API is used as the real-time voice layer. The adapter connects to:

```
wss://agents.assemblyai.com/v1/ws
```

The orchestrator sends the system prompt, greeting and phase-specific tools, streams PCM audio, handles transcripts and tool calls, returns tool results, and requests the next agent reply.

### Action-oriented behavior

The agent is not a transcription machine. It calls typed actions such as `record_incident_basics`, `record_vehicle_damage`, `request_photo_upload`, `mark_field_unknown`, `generate_report`, `send_report_email` and `escalate_safety_concern`.

The server controls phase transitions through explicit actions such as `confirm_continue`, `finish_evidence_capture` and `confirm_claim_summary`.

### Safety and edge cases

Prompt and tool behavior cover injury/ongoing danger, unsafe photo capture, unknown facts, corrections, uncertain identifiers, inability to continue, and avoiding fault, legal or coverage determinations.

## Local setup

### Prerequisites

Use:

- Node.js 20 or newer.
- npm.
- A modern browser with microphone access.
- An AssemblyAI API key.

Node 20+ is recommended for the project runtime. The application has separate Next.js and Node/TypeScript processes, so both must be running during the local demo.

### 1. Clone the repository

```bash
git clone https://github.com/Abhishek-00756/assembly_ai.git
cd assembly_ai
```

### 2. Install dependencies

Install from the repository root:

```bash
npm install
```

The repository uses npm workspaces for:

- `packages/*`
- `orchestrator`
- `web`

You can run the two applications from the root with the workspace scripts described below.

### 3. Configure the orchestrator

Create the local environment file:

```bash
cp orchestrator/.env.example orchestrator/.env
```

Edit it:

```bash
nano orchestrator/.env
```

For a local demo, use:

```env
ASSEMBLYAI_API_KEY=your_assemblyai_api_key

ORCHESTRATOR_PORT=8787
AUTH_MODE=demo
REPOSITORY_MODE=local
INSURANOS_LOCAL_DATA_DIR=../.localdata
```

The following integrations are optional for local development and can remain blank:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
RESEND_API_KEY=
REPORT_FROM_EMAIL=
```

The AssemblyAI key is a server-side secret. Do not put it in `web/.env.local`, browser code, GitHub source files, or client-side JavaScript.

### 4. Configure the web app

Create the local web environment file:

```bash
cp web/.env.example web/.env.local
```

The local values are:

```env
ORCHESTRATOR_HTTP_URL=http://localhost:8787
NEXT_PUBLIC_ORCH_WS_URL=ws://localhost:8787
```

These variables connect Next.js API routes and the browser WebSocket client to the local orchestrator.

### 5. Start the orchestrator

Open Terminal 1:

```bash
cd ~/assembly_ai
npm run dev:orchestrator
```

Expected output:

```
Insuranos orchestrator listening on http://localhost:8787 and ws://localhost:8787
```

Keep this terminal running.

### 6. Start the web application

Open Terminal 2:

```bash
cd ~/assembly_ai
npm run dev:web
```

Expected output is similar to:

```
Local: http://localhost:3000
```

If port 3000 is already in use, Next.js automatically selects another available port, such as 3001. Use the URL printed in the terminal.

Keep Terminal 2 running.

### 7. Open the application

Open the URL printed by Next.js, for example:

```
http://localhost:3000
```

or:

```
http://localhost:3001
```

Enter a demo name and email and click **Start voice report**.

On the call page:

1. Wait for the status to show **Connected**.
2. Click **Start microphone**.
3. Allow microphone access in the browser.
4. Answer the safety question first.
5. Continue through the claim flow.
6. Use the photo prompt when the agent requests evidence.
7. Confirm the claim summary before report generation.

For the first smoke test, use fictional accident information rather than real insurance or incident data.

### 8. Verify a session from the command line

Each session has an ID in the call-page URL:

```
/call?session=<SESSION_ID>
```

You can inspect the server-owned session directly:

```bash
curl -s "http://localhost:8787/api/sessions/<SESSION_ID>" | python3 -m json.tool
```

Useful fields include:

- `session.current_phase`
- `session.status`
- `session.claim_data`
- `completeness.missingRequired`
- `completeness.isReportEligible`
- `report`

A successfully completed required-data pass should have:

```json
"missingRequired": [],
"isReportEligible": true
```

### Local HTTP endpoints

The orchestrator exposes:

```
POST /api/sessions/demo
GET  /api/sessions/:sessionId
POST /api/photos
GET  /api/sessions/:sessionId/report/download
```

The voice connection uses:

```
ws://localhost:8787?session_id=<SESSION_ID>
```

### Local data and reset

The local repository writes data to `.localdata`.

To reset local demo data completely, stop the development servers and remove the directory:

```bash
rm -rf .localdata
```

The next demo session will start from a clean state.

### Common local issues

**Port 3000 is already in use**

Next.js will normally move to another port. Open the exact `Local:` URL shown in the terminal.

**Browser cannot use the microphone**

Allow microphone access for the localhost site in the browser settings, then reload the call page.

**Voice connection fails**

Verify that the orchestrator is running on port 8787 and that `ASSEMBLYAI_API_KEY` is present in `orchestrator/.env`. The key is only read by the server.

**The report email is not delivered**

Email requires Resend configuration:

```env
RESEND_API_KEY=...
REPORT_FROM_EMAIL=reports@yourdomain.com
```

Without Resend configuration, the claim/report flow can still be tested locally; email delivery is optional.

**PDF rendering fails**

PDF generation uses React-PDF and is invoked when `generate_report` runs. Keep PDF troubleshooting separate from the core voice-flow smoke test so a report-rendering dependency issue does not obscure AssemblyAI, tool or state-machine testing.

**Install-script warnings appear during npm install**

npm may report pending install scripts for packages such as `esbuild`. These are package-manager warnings rather than proof that Insuranos failed to install. Review and approve scripts through your npm configuration only when required by the local build.

### Optional type checks

From the repository root:

```bash
npm run typecheck -w @insuranos/orchestrator
npm run typecheck -w @insuranos/web
```

The orchestrator also provides:

```bash
npm run build -w @insuranos/orchestrator
npm run smoke -w @insuranos/orchestrator
```

## Phase 1 features

Phase 1 adds three server-owned capabilities while preserving the rule that the LLM is not the source of truth:

- **Auto-GPS + reverse geocoding:** the call page requests device location before microphone use. Latitude/longitude is sent to the orchestrator, reverse-geocoded, and saved as `incident_location`. The resolved location also satisfies the existing incident-location requirement, so the agent does not need to ask for it again.
- **Post-call summary + optional SMS:** the generated plain-text summary is always shown in the call UI even when email delivery is unavailable. Optional SMS delivery uses Twilio and the policyholder contact phone.
- **Photo metadata integrity:** before an uploaded evidence image is stored, the orchestrator checks EXIF capture time and GPS metadata when available. A mismatch is saved with the photo and surfaced in completeness/report output; the upload is not blocked.

### Phase 1 environment variables

Add these to `orchestrator/.env` when the corresponding feature is enabled:

```env
# Reverse geocoding
NOMINATIM_URL=https://nominatim.openstreetmap.org/reverse
NOMINATIM_USER_AGENT=Insuranos/1.0 (local demo)

# Photo integrity thresholds
PHOTO_EXIF_MAX_DELTA_HOURS=24
PHOTO_GPS_MAX_DISTANCE_M=1000

# Optional SMS
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
TWILIO_DEFAULT_COUNTRY_CODE=+91
```

Location permission is optional. The voice claim flow continues when the caller denies or the browser cannot provide GPS. The local demo uses OpenStreetMap Nominatim for reverse geocoding with an identifying User-Agent, caching, and rate limiting. Production deployments should use a geocoder appropriate for their traffic and privacy requirements.

## Optional cloud mode

Set:

```env
REPOSITORY_MODE=supabase
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Then:

1. Run `db/schema.sql` against the Supabase project.
2. Create private `evidence` and `reports` Storage buckets.
3. Configure the corresponding credentials in the orchestrator environment.

Cloud mode is optional for the local demo; `REPOSITORY_MODE=local` is sufficient for the end-to-end voice test.

## Optional email

Set:

```env
RESEND_API_KEY=...
REPORT_FROM_EMAIL=reports@yourdomain.com
```

The report generation flow does not require Resend. Email delivery is an optional integration.

## Development workflow

For normal local development:

```text
Terminal 1  →  npm run dev:orchestrator
Terminal 2  →  npm run dev:web
Browser     →  http://localhost:<printed-port>
```

The recommended development sequence is:

```text
Install
  ↓
Configure server secret
  ↓
Start orchestrator
  ↓
Start Next.js
  ↓
Create demo session
  ↓
Run voice intake
  ↓
Verify server state
  ↓
Test evidence/photos
  ↓
Test PDF
  ↓
Test email
```

## Boundary

This is an FNOL intake assistant, not a fault adjudicator, legal advisor, medical triage system, or insurer coverage decision engine.
