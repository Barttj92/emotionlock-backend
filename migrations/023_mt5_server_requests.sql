-- D-058: broker servers users tried that MetaKit did not support yet.
-- The backend mails the user once, checks MetaKit's broker list hourly and
-- mails + pushes the user as soon as the server is listed. Service role only.
create table if not exists public.mt5_server_requests (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  server text not null,
  login text,
  status text not null default 'pending' check (status in ('pending','notified','resolved','expired')),
  user_mailed_at timestamptz,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mt5_server_requests_pending_idx on public.mt5_server_requests (status) where status = 'pending';
create index if not exists mt5_server_requests_user_idx on public.mt5_server_requests (user_id);
alter table public.mt5_server_requests enable row level security;
comment on table public.mt5_server_requests is 'Broker servers users tried that MetaKit did not support yet (D-058). Backend only (service role).';
