-- 006_push_opens.sql
-- Tap/click tracking for the Command Center Push tab.
--
-- deep_link records which in-app destination a send was configured to open
-- (see PUSH_DEEP_LINKS in index.js). push_opens is a per-recipient log of
-- confirmed taps: the iOS app posts to POST /push-opened from
-- userNotificationCenter(_:didReceive:) in AppDelegate, carrying the
-- pushSendId that was embedded in the notification's payload when it was sent.
-- Kept as its own table (rather than updating push_sends.recipients jsonb)
-- so recording an open is a plain insert, not a read-modify-write.
--
-- Run once against the production Supabase project (ixlmaqkhgjgmijlbstia).
-- Applied via Supabase migration `add_push_opens_and_deep_link` on 2026-08-25.

ALTER TABLE public.push_sends
    ADD COLUMN IF NOT EXISTS deep_link text;

CREATE TABLE IF NOT EXISTS public.push_opens (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    push_send_id     uuid NOT NULL REFERENCES public.push_sends(id) ON DELETE CASCADE,
    user_id          text NOT NULL,
    opened_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per (send, user): repeated taps on the same notification shouldn't
-- inflate the open count.
CREATE UNIQUE INDEX IF NOT EXISTS push_opens_send_user_idx
    ON public.push_opens (push_send_id, lower(user_id));

CREATE INDEX IF NOT EXISTS push_opens_send_id_idx
    ON public.push_opens (push_send_id);

-- RLS on, service-role only (same posture as push_sends). The backend inserts
-- via the service role key from the public /push-opened endpoint (no admin
-- key — it's called by a user's own phone, rate-limited instead).
ALTER TABLE public.push_opens ENABLE ROW LEVEL SECURITY;
