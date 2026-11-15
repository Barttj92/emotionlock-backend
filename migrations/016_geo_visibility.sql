-- GEO tab in the Command Center (D-030, D-033). Additive only.
-- Applied to Supabase on 2026-11-15 through the Supabase connector, together
-- with the seed rows (baseline week and the first eight gaps).
-- aiv_weekly: one row per weekly gap-scan. aiv_gaps: living list of questions
-- where others are in AI answers and EmotionLock is not.
-- RLS on, no policies: only the service role can read or write.

create table if not exists public.aiv_weekly (
  week_start date primary key,
  ai_sessions_28d integer,
  ai_sessions_real_28d integer,
  app_store_clicks_28d integer,
  video_plays_28d integer,
  prompts_total integer not null default 0,
  prompts_mentioned integer not null default 0,
  prompts_cited integer not null default 0,
  measured_via text not null default 'web_search',
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.aiv_gaps (
  id bigint generated always as identity primary key,
  priority integer not null default 100,
  question text not null,
  prompt_refs text,
  winners text,
  why text,
  action text,
  kind text not null default 'site' check (kind in ('site', 'off-site', 'site-fix')),
  status text not null default 'open' check (status in ('open', 'made', 'visible', 'dropped')),
  slug text,
  needs_bart boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.aiv_weekly enable row level security;
alter table public.aiv_gaps enable row level security;
