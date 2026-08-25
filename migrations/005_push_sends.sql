-- 005_push_sends.sql
-- Send log for the Command Center Push tab (POST /admin/send-push).
--
-- One row per send action (an admin picking an individual user, a Users-tab
-- style segment, or "all users with push enabled"), not one row per
-- recipient — the per-recipient breakdown lives in `recipients` (jsonb) so
-- history stays readable without a join. Device tokens are never stored
-- here or anywhere outside `purchases.device_token`.
--
-- Run once against the production Supabase project (ixlmaqkhgjgmijlbstia).
-- Applied via Supabase migration `create_push_sends` on 2026-08-25.

CREATE TABLE IF NOT EXISTS public.push_sends (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title            text NOT NULL,
    body             text NOT NULL,
    -- Human-readable label for how the audience was picked: 'individual',
    -- 'all_push_enabled', or a Users-tab filter key like 'trial_active'.
    -- Purely descriptive, not used for re-sending.
    segment          text,
    recipient_count  integer NOT NULL DEFAULT 0,
    success_count    integer NOT NULL DEFAULT 0,
    failed_count     integer NOT NULL DEFAULT 0,
    skipped_count    integer NOT NULL DEFAULT 0,
    -- [{ user_id, status: 'sent'|'failed'|'skipped', error? }] — no device tokens.
    recipients       jsonb NOT NULL DEFAULT '[]'::jsonb,
    sent_by          text,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_sends_created_at_idx
    ON public.push_sends (created_at DESC);

-- RLS on, service-role only (same posture as backlog_items / instagram_posts).
-- The backend and website both use the service role key, which bypasses RLS.
ALTER TABLE public.push_sends ENABLE ROW LEVEL SECURITY;
