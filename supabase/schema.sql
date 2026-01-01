-- Queue table (FIFO up to 5 enforced in app logic)
create table if not exists public.request_queue (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid,
  status text not null check (status in ('queued','running','done','failed')) default 'queued',
  error text,
  result_meta jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

alter table public.request_queue
enable row level security;

-- Model state: one-row table keyed by id=1
create table if not exists public.model_state (
  id int primary key default 1,
  pod_status text not null default 'unknown',
  last_start_at timestamptz,
  last_stop_at timestamptz,
  last_request_at timestamptz,
  updated_at timestamptz not null default now()
);

-- lock it down (service role only)
alter table public.model_state
enable row level security;
