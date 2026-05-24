-- 001_subscription_lifecycle.sql
-- Subscription lifecycle additions for:
--   1) Backend gating of /status, /connect-mt5 and the trade-polling loop on
--      active subscription state.
--   2) The /apple/notifications webhook (App Store Server Notifications V2),
--      which needs originalTransactionId + appAccountToken to map an Apple
--      notification back to a userId.
--   3) The periodic MetaAPI cleanup job, which records when a user's account
--      was last undeployed for cost reasons.
--
-- Run this once against the production Supabase project (ixlmaqkhgjgmijlbstia).
-- All columns are nullable so existing rows are unaffected.

ALTER TABLE public.purchases
    ADD COLUMN IF NOT EXISTS original_transaction_id text,
    ADD COLUMN IF NOT EXISTS app_account_token       text,
    ADD COLUMN IF NOT EXISTS meta_api_undeployed_at  timestamptz,
    ADD COLUMN IF NOT EXISTS subscription_updated_at timestamptz;

-- The webhook looks users up by originalTransactionId when appAccountToken is
-- missing (older purchases made before the iOS update that adds the token).
-- Partial index because most rows do not have this field set yet.
CREATE INDEX IF NOT EXISTS purchases_original_transaction_id_idx
    ON public.purchases (original_transaction_id)
    WHERE original_transaction_id IS NOT NULL;

-- The webhook also looks users up by appAccountToken (preferred path for any
-- purchase made after the iOS update). UUID format, lowercased.
CREATE INDEX IF NOT EXISTS purchases_app_account_token_idx
    ON public.purchases (app_account_token)
    WHERE app_account_token IS NOT NULL;

-- The cleanup job scans for expired subs past the 48h grace window. Indexing
-- subscription_status lets it skip the full-table scan as the user base grows.
CREATE INDEX IF NOT EXISTS purchases_subscription_status_idx
    ON public.purchases (subscription_status)
    WHERE subscription_status IS NOT NULL;
