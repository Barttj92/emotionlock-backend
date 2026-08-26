-- 007_user_overview_meta_api_account_id.sql
-- Exposes purchases.meta_api_account_id on the public.user_overview view so
-- the Command Center Users tab can show, per user, which MetaAPI cloud
-- account is theirs. Lets admin copy the id straight into app.metaapi.cloud
-- and delete the account for an inactive user, instead of it sitting there
-- billing hourly with no easy way to trace it back to a person.
--
-- New column appended at the end of the SELECT list (CREATE OR REPLACE VIEW
-- cannot reorder or insert columns before existing ones). security_invoker
-- and the anon/authenticated REVOKE from the 2026-08-22 fix
-- (see fix_security_definer_views_public_exposure) are re-asserted, not
-- relaxed — this view stays service_role-only.
--
-- Run once against the production Supabase project (ixlmaqkhgjgmijlbstia).
-- Applied via Supabase migration `add_meta_api_account_id_to_user_overview`
-- on 2026-08-26.

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
    pu.meta_api_account_id IS NOT NULL AS has_mt5,
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

REVOKE ALL PRIVILEGES ON public.user_overview FROM anon, authenticated;
