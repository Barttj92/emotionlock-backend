-- 004_onboarding_events.sql
-- Per-step onboarding / first-run funnel tracking.
--
-- The iOS app fires one event per first-run step it reaches: the 5 onboarding
-- slides (welcome, how_it_works, security, set_limit, ready), onboarding
-- completed, account created, MT5 connect screen shown, and MT5 connected.
-- Events are anonymous: keyed only by the Keychain UUID that already identifies
-- a user across the rest of the backend. No PII, no third-party SDK.
--
-- Idempotent by design: (user_id, step) is unique and the backend upserts with
-- ignoreDuplicates, so the table holds at most one row per user per step
-- ("did this user reach this step"). That keeps it tiny and makes the funnel a
-- plain per-step count. user_id is stored lowercased by the backend.
--
-- Run once against the production Supabase project (ixlmaqkhgjgmijlbstia).
-- Applied via Supabase migration `onboarding_events` on 2026-07-28.

CREATE TABLE IF NOT EXISTS public.onboarding_events (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    text NOT NULL,
    step       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per user per step. Lets the backend upsert idempotently and bounds
-- table growth to (users x steps).
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_events_user_step_idx
    ON public.onboarding_events (user_id, step);

-- The funnel query counts users per step, so index step.
CREATE INDEX IF NOT EXISTS onboarding_events_step_idx
    ON public.onboarding_events (step);

CREATE INDEX IF NOT EXISTS onboarding_events_created_at_idx
    ON public.onboarding_events (created_at);

-- RLS on, service-role only (same posture as every other table). The backend
-- uses the service role key which bypasses RLS; no client reads this table.
ALTER TABLE public.onboarding_events ENABLE ROW LEVEL SECURITY;
