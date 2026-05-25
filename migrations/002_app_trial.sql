-- 002_app_trial.sql
-- 1-week free trial after first MT5 connect.
--
-- Trial concept lives entirely in our own columns, separate from Apple's
-- subscription trial (trial_ends_at) so the two never get conflated:
--   app_trial_started_at   : timestamp of the user's first successful
--                            /connect-mt5. Set ONCE, never overwritten.
--   app_trial_ends_at      : app_trial_started_at + 7 days. Stored
--                            redundantly to make the scheduler query cheap.
--   trial_notified_24h_at  : when the "trial ends tomorrow" push was sent.
--                            NULL until the scheduler fires.
--   trial_notified_1h_at   : when the "trial ends in 1 hour" push was sent.
--
-- device_token is also promoted from in-memory to persistent storage so the
-- push scheduler can fire trial-expiry notifications even after a Railway
-- restart wipes userStates.
--
-- profiles.email gets a unique index so a returning user (different Apple
-- ID but same email) inherits their original trial start date instead of
-- getting a fresh 7 days. Combined with the explicit "no plus addressing"
-- check in /profile, this blocks the easiest reinstall-abuse vectors.
--
-- Run once against the production Supabase project (ixlmaqkhgjgmijlbstia).
-- All columns are nullable / defaulted so existing rows are unaffected.

ALTER TABLE public.purchases
    ADD COLUMN IF NOT EXISTS app_trial_started_at   timestamptz,
    ADD COLUMN IF NOT EXISTS app_trial_ends_at      timestamptz,
    ADD COLUMN IF NOT EXISTS trial_notified_24h_at  timestamptz,
    ADD COLUMN IF NOT EXISTS trial_notified_1h_at   timestamptz,
    ADD COLUMN IF NOT EXISTS device_token           text;

-- The scheduler scans for users whose trial ends within the next 25h or 75min
-- and who haven't been notified yet. Partial index keeps the working set small.
CREATE INDEX IF NOT EXISTS purchases_app_trial_ends_at_idx
    ON public.purchases (app_trial_ends_at)
    WHERE app_trial_ends_at IS NOT NULL;

-- Block "plus addressing" abuse: gmail+1, gmail+2 all map to the same inbox
-- but produce different "unique" rows. The /profile endpoint rejects '+'
-- before we hit Supabase, but a unique index on the canonical email is the
-- belt-and-braces fallback: even if two profile rows somehow get created
-- with the same email, the second insert fails loudly.
--
-- Existing rows MAY already have duplicate emails. We run the unique index
-- as CONCURRENTLY-not-needed (small table) and IF NOT EXISTS so the
-- migration is idempotent. If a duplicate is detected at index creation
-- time it will fail; resolve manually first.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_unique_idx
    ON public.profiles (email)
    WHERE email IS NOT NULL;
