-- GEO tab: Google AI Overviews and AI Mode impressions from the Search Console
-- report "Generative AI features" (not in the API, read weekly in Chrome by the gap-scan, D-047).
-- Additive.
alter table public.aiv_weekly
  add column if not exists google_ai_impressions_28d integer,
  add column if not exists google_ai_impressions_prev_28d integer,
  add column if not exists google_ai_pages jsonb;
