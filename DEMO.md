# 5-minute demo script

## Start
Terminal 1:
```bash
cd orchestrator
cp .env.example .env
# add ASSEMBLYAI_API_KEY
npm install
npm run dev
```

Terminal 2:
```bash
cd web
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

## Judging walkthrough
Use the demo identity screen.

Say:
> "I was just in a rear-end accident. I'm not hurt and I'm still at the scene."

Then answer one question at a time. For plate/policy data, read it slowly. For one unavailable other-party field, say:
> "I don't know their policy number."

The agent should use `mark_field_unknown` instead of looping.

When evidence starts, take a photo through the browser camera prompt. The local demo stores it outside the voice channel and sends a confirmation event back to the orchestrator.

During review, deliberately correct one fact:
> "Actually, the road was wet, not dry."

The agent should record the corrected group again and continue.

After confirmation, the agent generates the report and the browser exposes the PDF. Email delivery is attempted only when `RESEND_API_KEY` is configured.

## Architecture points to explain
- AssemblyAI Voice Agent API = STT + turn-taking + LLM + TTS over one WebSocket.
- Narrow claim tools = real actions, not voice-to-text.
- ClaimSchema = single source of truth.
- Completeness engine = server-owned next-question state.
- State machine = server controls phase transitions.
- `UNKNOWN` sentinel = no hallucination and no re-ask loop.
- Photo binary path is separate from voice audio.
- Report generation is decoupled from the live call.
