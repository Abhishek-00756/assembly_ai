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
  status text not null default 'in_progress' check (status in ('in_progress', 'paused', 'review', 'completed')),
  current_phase text not null default 'opening_safety' check (current_phase in ('opening_safety','grounding_consent','narrative','structured_gathering','evidence','review','output_generation','closing')),
  claim_data jsonb not null default '{}'::jsonb,
  requires_followup boolean not null default false,
  started_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_claim_sessions_resume on claim_sessions (claimant_id, status);
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
