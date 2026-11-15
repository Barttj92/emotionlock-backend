-- GEO tab: real citation data from Bing Webmaster Tools (AI Performance) and
-- Microsoft Clarity (AI Visibility > Citations), read weekly by the gap-scan.
-- Additive. Applied to Supabase on 2026-11-15 through the Supabase connector.
alter table public.aiv_weekly
  add column if not exists bing_citations integer,
  add column if not exists bing_cited_pages integer,
  add column if not exists bing_queries jsonb,
  add column if not exists clarity_citations integer,
  add column if not exists clarity_queries jsonb;
