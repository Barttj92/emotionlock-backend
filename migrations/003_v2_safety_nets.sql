-- 003_v2_safety_nets.sql
-- Schema additions for App Store v2 ship. Adds two columns to `purchases`:
--   first_setup_complete: one-shot latch that closes the initial-setup loophole
--                         (free maxTrades change was previously possible every
--                          Monday after the Sunday token reset)
--   last_token_reset:     timestamp of the most recent emergency-token reset.
--                         Backfills the weekly-reset cron sweep so we can
--                         identify rows that have not been swept this week.
--
-- Both columns are nullable for forward compatibility. Existing rows are
-- backfilled so they don't get the "free initial setup" loophole.

-- 1. first_setup_complete
ALTER TABLE purchases
    ADD COLUMN IF NOT EXISTS first_setup_complete boolean DEFAULT false;

-- Backfill: any existing user who has ever configured the app (non-default
-- max_trades, has trades on record, has a license, or has started their app
-- trial) is treated as past-the-initial-setup, so the loophole is closed
-- for them too. New v2 installs start at false and get exactly one free
-- setup before the latch flips.
UPDATE purchases
   SET first_setup_complete = true
 WHERE first_setup_complete IS DISTINCT FROM true
   AND (
        max_trades IS NOT NULL AND max_trades <> 1
     OR daily_trades_count IS NOT NULL AND daily_trades_count > 0
     OR license_code IS NOT NULL
     OR app_trial_started_at IS NOT NULL
     OR original_transaction_id IS NOT NULL
   );

-- 2. last_token_reset
ALTER TABLE purchases
    ADD COLUMN IF NOT EXISTS last_token_reset timestamptz;

-- Backfill last_token_reset to "now" for everyone — they have whatever
-- tokens they currently have, no need to reset on the next cron tick.
UPDATE purchases
   SET last_token_reset = now()
 WHERE last_token_reset IS NULL;

-- Index for the cron-sweep query (find users whose last_token_reset is
-- older than the most recent Sunday 22:00 boundary). Partial index keeps
-- it cheap.
CREATE INDEX IF NOT EXISTS idx_purchases_last_token_reset
    ON purchases (last_token_reset)
 WHERE last_token_reset IS NOT NULL;
