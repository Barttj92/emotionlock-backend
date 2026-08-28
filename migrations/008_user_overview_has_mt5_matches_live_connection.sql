-- has_mt5 previously meant "meta_api_account_id was ever set", which stays
-- true even after Bart manually deletes the MetaAPI account (undeploy) via
-- his cleanup workflow (see 007_user_overview_meta_api_account_id.sql /
-- project memory: MetaAPI ID column). That made "MT5 Connected" on the Users
-- tab, Dashboard and Revenue tiles disagree with the user_engagement RPC,
-- which already used the stricter "still actually connected" check. Align
-- has_mt5 to the same definition so every Command Center tab reports the
-- same MT5 truth. Applied directly to prod Supabase (ixlmaqkhgjgmijlbstia)
-- on 2026-08-28 via the Supabase MCP; this file just tracks it locally.
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
    pu.meta_api_account_id
   FROM profiles pr
     FULL JOIN purchases pu ON lower(pr.user_id) = lower(pu.user_id::text)
     LEFT JOIN attributions a ON lower(a.user_id) = lower(COALESCE(pr.user_id, pu.user_id::text));

-- Re-assert the 2026-08-22 lockdown (security_invoker + no anon/authenticated
-- grants) since CREATE OR REPLACE VIEW can reset grants.
REVOKE ALL ON public.user_overview FROM anon, authenticated;
GRANT SELECT ON public.user_overview TO service_role;
