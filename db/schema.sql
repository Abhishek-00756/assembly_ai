-- Insuranos FNOL voice agent — data architecture
create extension if not exists "pgcrypto";

create table if not exists claimants (
  id uuid primary key default gen_random_uuid(),
  auth_mode text not null check (auth_mode in ('otp', 'demo')),
  phone_number text unique,
  display_name text,
  email text,
  created_at timestamptz not null default now()
);
create table if not exists claim_sessions (
  id uuid primary key default gen_random_uuid(),
  claimant_id uuid not null references claimants(id) on delete cascade,
  incident_group_id text,
  status text not null default 'in_progress' check (status in ('in_progress', 'paused', 'review', 'completed')),
  current_phase text not null default 'opening_safety' check (current_phase in ('opening_safety','grounding_consent','narrative','structured_gathering','evidence','review','output_generation','closing')),
  claim_data jsonb not null default '{}'::jsonb,
  requires_followup boolean not null default false,
  started_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_claim_sessions_resume on claim_sessions (claimant_id, status);
create index if not exists idx_claim_sessions_incident_group on claim_sessions (incident_group_id);
do $ begin
  if exists (select 1 from information_schema.columns where table_name='claim_sessions' and column_name='incident_group_id' and data_type <> 'text') then
    alter table claim_sessions alter column incident_group_id type text using incident_group_id::text;
  end if;
end $;
create table if not exists knowledge_graph_edges (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references claim_sessions(id) on delete cascade,
  incident_group_id text not null,
  subject text not null,
  relation text not null,
  object_value text not null,
  source_tool text not null,
  created_at timestamptz not null default now(),
  unique(session_id, subject, relation)
);
create index if not exists idx_knowledge_graph_group on knowledge_graph_edges (incident_group_id);
create index if not exists idx_knowledge_graph_subject_relation on knowledge_graph_edges (subject, relation);
create table if not exists report_artifacts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references claim_sessions(id) on delete cascade,
  report_json jsonb,
  summary_text text,
  pdf_url text,
  emailed_to text,
  emailed_at timestamptz,
  email_status text check (email_status in ('pending','sent','failed'))
);
create table if not exists session_event_log (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references claim_sessions(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists idx_session_event_log_session on session_event_log (session_id, at);

alter table claimants enable row level security;
alter table claim_sessions enable row level security;
alter table report_artifacts enable row level security;
alter table session_event_log enable row level security;

alter table knowledge_graph_edges enable row level security;
