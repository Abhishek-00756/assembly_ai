# Post-Call Dashboard — Implementation Plan

A per-incident dashboard that opens when a call session ends. It renders a working
knowledge graph of that incident, the claim report (with a real PDF link), and a
detailed risk analysis, using the same visual language as the agent call page.

Status: **plan only — no code written yet.**

---

## 1. Goals and scope

| # | Goal | Acceptance |
|---|------|-----------|
| G1 | Dashboard opens automatically after the session ends | Navigating away from `/call` shows the dashboard for that session |
| G2 | Detailed knowledge graph of the incident | Nodes + labelled relations for everything actually collected; cross-party sessions when present |
| G3 | Report section with working PDF | Links to the PDF; clearly explains any failure instead of silently omitting it |
| G4 | Detailed risk analysis | Context score, provider status, every weather/traffic signal, coverage gaps, and the explicit "not a liability decision" framing |
| G5 | Same UI as the agent page | Reuses the exact primitives in §6; slate palette, no new colour system |
| G6 | Searchable by incident code | Human-readable `INC-XXXXXX` code so a claim can be found again later |

**Explicitly out of scope:** the separate "Incident Knowledge Graph" page seen in earlier
screenshots. That code is not in this repository and is not being reproduced. This dashboard
is self-contained.

---

## 2. Verified findings that drive the plan

These were confirmed by reading the code, not assumed.

| # | Finding | Evidence | Impact |
|---|---------|----------|--------|
| F1 | No graph HTTP endpoint exists | `graphStore.ts` exposes only `syncSession` / `edgesForGroup` / `findConflicts` | The dashboard has nothing to fetch; an API must be built |
| F2 | No session-level graph query | Only `edgesForGroup` exists, and it filters by `incident_group_id` | A single-incident view needs a new `edgesForSession` |
| F3 | `context_factors` is absent from the graph | `edgesFromSession` (`graphStore.ts:21-26`) emits no external-context edge | The graph structurally cannot show risk output — must be added |
| F4 | `context_factors` is absent from `summary_text` | `buildReport.ts:28` includes only `groups`, `flagged_gaps`, `next_steps` | Text surfaces show no risk analysis |
| F5 | PDF failure is silently swallowed | `handlers.ts:25` catches, logs to `session_event_log`, still returns `{ok:true, generated:true}` | Produces "report exists, no PDF" with no user-visible cause |
| F6 | `report_json` omits risk in text form | `buildReport.ts:28` | Dashboard must read structured `context_factors`, not `summary_text` |
| F7 | No human-readable incident code | `ClaimSession` (`types.ts:7`) has only `id` (UUID) + `incident_group_id` | Blocks G6 and makes support lookups painful |
| F8 | `cross_party_context` is cloud-only | `reconcileAtReview` returns early unless `crossInsurer.enabled` (Supabase) | In local mode the dashboard must degrade explicitly, not show empty |
| F9 | Report eligibility gates generation | `handlers.ts:25` requires `isReportEligible` | An incomplete call yields no report at all; dashboard must say why |
| F10 | Graph JSON is a separate file | `knowledge-graph.json` vs `insuranos.json` (`localDb.ts`) | Dashboard needs a joined read, not a raw file fetch |

---

---

## 3. Architecture

```
Call page (/call)  ──"End" / report_ready──▶  /dashboard?session=<id>
                                                      │
                          GET /api/sessions/:id/dashboard  (one round trip)
                                                      │
                    ┌─────────────────────────────────┴──────────────────┐
                    ▼                                 ▼                    ▼
              incident summary              graph nodes + edges      report + risk
              completeness                  (this + group peers)    (artifact + PDF)
```

**One consolidated endpoint.** The dashboard is a read-only post-mortem view of immutable
data; a single `GET` avoids three sequential fetches and lets the server join the graph file
with the claim DB and the report artifact in one pass.

### 3.1 Response contract

```ts
// GET /api/sessions/:id/dashboard
{
  incident: {
    id, incident_code, incident_group_id, status, current_phase,
    started_at, completed_at, requires_followup
  },
  claimant: { display_name, email, phone_number },
  completeness: CompletenessResult,          // reuse existing shape
  graph: {
    nodes: [{ id, type, label, value, status, meta }],
    edges: [{ from, to, relation, source_tool }],
    conflicts: string[],
    peer_sessions: [{ id, incident_code, status }]
  },
  report: {
    generated: boolean,
    eligible: boolean,                        // completeness.isReportEligible
    blocked_reason: string | null,            // F9
    pdf_status: "pending" | "ready" | "failed" | "none",
    pdf_error: string | null,                 // F5
    pdf_url: string | null,
    download_url: string | null,              // stable local path
    summary_text: string | null,
    report_json: unknown | null,
    email_status, emailed_to, emailed_at
  },
  risk: {
    available: boolean,
    context_score: number | null,
    provider_status: { weather, traffic },
    weather: ContextWeather | null,
    traffic: ContextTraffic | null,
    factors: string[],                        // includes coverage notes
    interpretation: string | null,            // plain-language, non-legal
    is_liability_decision: false             // always false; stated explicitly
  },
  cross_party: { available, related_session_count, grounded_narrative, conflicts, note }
}
```

`cross_party.note` explains the F8 degradation ("Cross-party reconciliation requires
Supabase cloud mode; not available in this local session.") instead of rendering blank.

---

## 4. Backend changes

### Step 1 — Incident codes (unblocks G6)
- `orchestrator/src/types.ts` — add `incident_code: string` to `ClaimSession`.
- `orchestrator/src/repository/JsonFileClaimRepository.ts` — generate in `createSession`
  (`INC-` + 6 uppercase alphanumerics), reject collisions; backfill on read for sessions
  saved before this change (no `incident_code` → derive and persist).
- `orchestrator/src/repository/IClaimRepository.ts` — add
  `findSessionByIncidentCode(code: string): Promise<ClaimSession | null>` (trim + case-insensitive).
- `db/schema.sql` — add column, unique index, and an idempotent backfill `DO` block
  (mirroring the existing `incident_group_id` migration style at lines 26-30).

### Step 2 — Graph extensions
- `orchestrator/src/graphStore.ts`
  - add `edgesForSession(sessionId)` — for the single-incident view (F2).
  - add external-context edges in `edgesFromSession` (F3):
    `context_score`, `weather_observed`, `weather_conditions`, `traffic_density`,
    `traffic_incidents`, `risk_factor` (one per factor).
  - add `nodesForSession(sessionId)` returning typed nodes so the API does not
    re-derive node types in the web layer.
- `db/schema.sql` — no schema change needed; existing columns cover the new relations.

### Step 3 — Dashboard endpoint
- `orchestrator/src/server.ts` — add `GET /api/sessions/:id/dashboard`, building the §3.1
  shape from `repo.getSession`, `computeCompleteness`, `graphStore`, and
  `repo.getReportArtifact`. Handle a missing session with `404 session_not_found`.
- Add `GET /api/incidents?code=INC-XXXXXX` for code lookup (used by the header search and
  as the recovery path when a URL is lost).

### Step 4 — PDF reliability (F5)
- `orchestrator/src/types.ts` + `db/schema.sql` — add `pdf_status`
  (`pending|ready|failed|none`) and `pdf_error` to `ReportArtifact`.
- `orchestrator/src/tools/handlers.ts` — in `generate_report`:
  1. render and upload the PDF **before** creating the artifact, so a failed render does
     not leave a half-built record;
  2. on failure, set `pdf_status: "failed"` + `pdf_error` and return
     `{ok:false, result:{error:"pdf_render_failed", detail}}` instead of a false success.
- `orchestrator/src/report/storage.ts` — always return a stable `download_url` alongside the
  Supabase signed URL, so the dashboard link does not silently expire (signed URLs are
  3600s TTL today).
- `orchestrator/src/report/buildReport.ts` — append a **risk summary line** to
  `summary_text` when `context_factors` is present (F4). Structured data stays the source
  of truth; this only fixes the text surface.

### Step 5 — Risk interpretation
- `orchestrator/src/riskEngine.ts` — export a pure `describeContext(factors)` that turns
  scores/factors into neutral plain language. Must not imply fault or coverage.
- Keep `is_liability_decision: false` a hard constant in the response and render it.

---

---

## 5. Frontend changes

### Step 6 — Dashboard route
`web/app/dashboard/page.tsx` — client component, reads `?session=<id>`.

Layout mirrors `/call` exactly (`min-h-screen px-4 py-6 md:px-8`, `mx-auto max-w-6xl`,
`grid gap-6 lg:grid-cols-[1fr_330px]`), but the **right rail is wider** (`380px`) because it
carries the risk panel. Section order:

1. **Header** — `INSURANOS` eyebrow, incident code, `status` + phase pills, timestamps,
   "Back to call" / "Start new claim" links.
2. **Stat strip** — 4 cards in `sm:grid-cols-2 lg:grid-cols-4`: Entities, Relations,
   Fields captured, Context score. Same `rounded-3xl border bg-white p-5 shadow-sm` +
   `text-3xl font-bold` treatment as the completeness card on the call page.
3. **Knowledge graph** — main column. Node cards grouped by type
   (Incident / Location / Vehicle / Policy / Other party / Photo / **External context**),
   each relation rendered as an arrow to its object value. Conflicting relations get the
   amber flag box used for photo metadata. Empty values render an amber `Not provided` pill
   (matching the intent of the earlier screenshot, in the agent page's palette).
4. **Risk analysis** — right rail, reusing the External context card added to `/call`:
   score block, provider rows, weather rows, traffic rows, and the amber `Context signals`
   box for `factors[]`. Includes the fixed non-liability disclaimer line.
5. **Report** — `summary_text`, delivery status, and a PDF button with three explicit states:
   - `ready` → **Open PDF report** (`rounded-xl bg-slate-900` link)
   - `failed` → amber box with `pdf_error` and a Retry button (`POST /api/sessions/:id/report`)
   - `none` → explain `blocked_reason` (F9) and link back to the missing fields
6. **Collected details** — full `completeness.fields` table using `FIELD_LABELS`, with a
   `filled` / `unknown` / `missing` badge per row.
7. **Cross-party** — only when `available`; otherwise render `note`.

### Step 7 — Open-on-end behaviour
- `web/app/call/page.tsx`:
  - on `report_ready`, keep setting the report URL and reveal a prominent
    **"View incident dashboard"** link in the Post-call summary card;
  - on the `End` button, record `sessionId` in `sessionStorage` under
    `insuranos:lastSession` before closing the socket.
- `web/app/page.tsx` — if `sessionStorage` holds a completed session, show a
  "Resume last incident dashboard" card on the landing page.
- Guard: only auto-navigate when the session reached `completed`/`closing`, so a mid-call
  refresh never yanks the user off the call.

### Step 8 — API proxy
- `web/app/api/sessions/[id]/dashboard/route.ts` — thin pass-through to the orchestrator,
  identical to the existing `location/route.ts` pattern (reads `ORCHESTRATOR_HTTP_URL`).

---

## 6. UI consistency rules

Reuse verbatim from `web/app/call/page.tsx`; introduce no new visual language.

| Element | Classes |
|---|---|
| Card | `rounded-3xl border bg-white p-5 shadow-sm` |
| Stat block | `rounded-2xl bg-slate-50 p-4` + `text-3xl font-bold` |
| Flag / signal box | `rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800` |
| Error box | `rounded-3xl border border-red-200 bg-red-50 p-5 text-sm text-red-700` |
| Status pill | `rounded-full ... px-3 py-1 text-xs font-semibold` (emerald/amber) |
| Primary button | `rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white` |
| Body text | `text-sm text-slate-600`; `text-xs text-slate-500` for labels |

Constraints: **slate + emerald + amber + red only.** No purple/indigo. Score colouring
reuses `scoreClass()` (≥60 amber, ≥30 slate, else emerald). Code style stays dense and
single-line, matching the rest of the repo.

---

## 7. Execution order

| Step | Work | Depends on |
|---|---|---|
| 1 | Incident codes | — |
| 2 | Graph edges + node queries | — |
| 3 | PDF reliability | — |
| 4 | `describeContext` + summary risk line | — |
| 5 | Dashboard endpoint | 1, 2, 3, 4 |
| 6 | Dashboard page | 5 |
| 7 | Open-on-end + landing resume link | 6 |
| 8 | API proxy route | 5 |

Steps 1-4 are backend-only and independently testable, which keeps the risky parts off the
critical path to a first renderable dashboard.

---

## 8. Verification

**Backend**
1. `npx tsc --noEmit` clean on both `orchestrator` and `web`.
2. `GET /api/sessions/:id/dashboard` returns 200 with all sections populated for a
   completed session.
3. `nodes`/`edges` are non-empty for a real call; a `context_score` edge exists when
   enrichment ran.
4. `findSessionByIncidentCode` is case-insensitive and returns `null` for an unknown code.
5. **PDF negative test** — force a render failure, then assert `pdf_status === "failed"`,
   `pdf_error` is non-empty, and the tool returns `ok: false` (not a silent success).
6. PDF download returns 200 with a `%PDF-` magic-byte body.

**Frontend**
7. Dashboard renders with no console errors and no hydration warnings.
8. Risk panel shows "Not available" gracefully when `context_factors` is null.
9. Report section shows each of the three states (ready / failed / blocked) correctly.
10. "View incident dashboard" appears after `report_ready` and the link resolves.

**Regression**
11. Voice flow unaffected: run a full session to `closing` and confirm phase transitions
    and the existing `/call` panels still behave — especially the External context card
    added earlier in this work.

---

## 9. Risks and open questions

| Risk | Mitigation |
|---|---|
| `knowledge-graph.json` and `insuranos.json` can drift (F10) | Dashboard endpoint reads both server-side; never expose raw files to the client |
| Supabase signed URLs expire in 3600s | Always return a stable `download_url`; the dashboard prefers it |
| Older sessions lack `incident_code` and context edges | Lazy backfill on read (Step 1); the page tolerates missing nodes |
| React-PDF failing in constrained environments | `pdf_status` surfaces the real error; report text stays available |
| Growing dashboard payload | Response is a single read; add field-level filtering only if it becomes slow |
| Cross-party data absent locally (F8) | Explicit `note`, never a blank panel |

**Open questions**

1. Should the dashboard auto-navigate the moment the call ends, or offer a link the user
   clicks? The plan assumes a link plus a landing-page resume card — auto-navigation risks
   losing the transcript view the caller may still be reading.
2. Should `/dashboard?session=<uuid>` be publicly reachable, or gated behind a token? As
   specified it exposes PII (name, email, phone) with no authentication.
3. Is `INC-XXXXXX` the format you want, and must it match a code issued by an external
   system?

---
