-- Loss-limit mode (feature/loss-limit). Purely additive: new nullable
-- columns with safe defaults, no existing column is changed or dropped, so
-- the current backend on main keeps working unchanged when this runs first.
--
-- Deploy order: run this migration BEFORE deploying the feature branch.
-- Rollback: nothing needed, older code ignores these columns. Dropping them
-- is possible later but irreversible (data loss), so only do that on purpose.
--
-- Applied to prod Supabase (ixlmaqkhgjgmijlbstia) on 2026-09-30 via the
-- Supabase MCP after Bart's approval. All 60 existing rows got limit_mode 'trades'.

ALTER TABLE public.purchases
    ADD COLUMN IF NOT EXISTS limit_mode          text          NOT NULL DEFAULT 'trades',
    ADD COLUMN IF NOT EXISTS max_daily_loss      numeric(14,2),
    ADD COLUMN IF NOT EXISTS pending_limit_mode  text,
    ADD COLUMN IF NOT EXISTS pending_limit_value numeric(14,2),
    ADD COLUMN IF NOT EXISTS daily_net_pnl       numeric(14,2),
    ADD COLUMN IF NOT EXISTS daily_pnl_date      date,
    ADD COLUMN IF NOT EXISTS loss_unlock_pending boolean       NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS account_currency    text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchases_limit_mode_check') THEN
        ALTER TABLE public.purchases
            ADD CONSTRAINT purchases_limit_mode_check CHECK (limit_mode IN ('trades', 'loss'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchases_pending_limit_mode_check') THEN
        ALTER TABLE public.purchases
            ADD CONSTRAINT purchases_pending_limit_mode_check CHECK (pending_limit_mode IS NULL OR pending_limit_mode IN ('trades', 'loss'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchases_max_daily_loss_check') THEN
        ALTER TABLE public.purchases
            ADD CONSTRAINT purchases_max_daily_loss_check CHECK (max_daily_loss IS NULL OR (max_daily_loss >= 1 AND max_daily_loss <= 10000000));
    END IF;
END $$;

-- Command Center: expose the chosen mode. New columns are appended at the
-- end, which CREATE OR REPLACE VIEW allows. Body otherwise identical to 008.
CREATE OR REPLACE VIEW public.user_overview
WITH (security_invoker = on) AS
 SELECT COALESCE(pr.user_id, pu.user_id::text) AS user_id,
    pr.first_name,
    pr.last_name,
    pr.email,
    pr.created_at AS profile_created_at,
    pu.id AS purchase_id,
    pu.license_code,
    pu.subscription_status,
    (pu.mt5_login IS NOT NULL AND pu.mt5_login <> '' AND pu.meta_api_undeployed_at IS NULL) AS has_mt5,
    pu.mt5_login,
    pu.mt5_server,
    pu.max_trades,
    pu.daily_trades_count,
    pu.daily_trades_date,
    pu.emergency_tokens_remaining,
    pu.created_at AS purchase_created_at,
    COALESCE(pr.created_at, pu.created_at) AS joined_at,
    pu.license_code IS NOT NULL AS has_license,
    pu.subscription_status = ANY (ARRAY['active'::text, 'trialing'::text]) AS has_active_subscription,
    pu.trial_ends_at,
    pu.app_trial_started_at,
    pu.app_trial_ends_at,
    a.source AS referral_source,
    pu.meta_api_account_id,
    pu.limit_mode,
    pu.max_daily_loss,
    pu.account_currency
   FROM profiles pr
     FULL JOIN purchases pu ON lower(pr.user_id) = lower(pu.user_id::text)
     LEFT JOIN attributions a ON lower(a.user_id) = lower(COALESCE(pr.user_id, pu.user_id::text));

REVOKE ALL ON public.user_overview FROM anon, authenticated;
GRANT SELECT ON public.user_overview TO service_role;
