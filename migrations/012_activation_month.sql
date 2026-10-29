-- 012_activation_month.sql
-- The one-time MT5 Activation license now includes 30 days of full access.
-- The monthly subscription is only needed after that window.
--
--   license_period_ends_at     : end of the included month. Set ONCE on the
--                                first license /purchase as
--                                max(Apple purchase date, app_trial_ends_at) + 30d.
--                                Never moved by restores or re-purchases. A
--                                refund clears license_code, which ends access
--                                even though this column stays.
--   activation_notified_3d_at  : "included month ends in 3 days" push sent.
--   activation_notified_1d_at  : "included month ends tomorrow" push sent.
--
-- Also exposes the new column on user_overview (Command Center) and
-- email_user_state (email automations). Columns are appended at the end so
-- CREATE OR REPLACE VIEW stays valid.
--
-- Additive only: existing rows keep NULL, which means "no activation month".
-- Backfill for existing license holders is in 013 (run on iOS release day).

ALTER TABLE public.purchases
    ADD COLUMN IF NOT EXISTS license_period_ends_at    timestamptz,
    ADD COLUMN IF NOT EXISTS activation_notified_3d_at timestamptz,
    ADD COLUMN IF NOT EXISTS activation_notified_1d_at timestamptz;

CREATE INDEX IF NOT EXISTS purchases_license_period_ends_at_idx
    ON public.purchases (license_period_ends_at)
    WHERE license_period_ends_at IS NOT NULL;

CREATE OR REPLACE VIEW public.user_overview WITH (security_invoker = on) AS
 SELECT COALESCE(pr.user_id, pu.user_id::text) AS user_id,
    pr.first_name,
    pr.last_name,
    pr.email,
    pr.created_at AS profile_created_at,
    pu.id AS purchase_id,
    pu.license_code,
    pu.subscription_status,
    pu.mt5_login IS NOT NULL AND pu.mt5_login <> ''::text AND pu.meta_api_undeployed_at IS NULL AS has_mt5,
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
    pu.account_currency,
    pu.license_period_ends_at
   FROM profiles pr
     FULL JOIN purchases pu ON lower(pr.user_id) = lower(pu.user_id::text)
     LEFT JOIN attributions a ON lower(a.user_id) = lower(COALESCE(pr.user_id, pu.user_id::text));

CREATE OR REPLACE VIEW public.email_user_state WITH (security_invoker = on) AS
 SELECT c.id AS contact_id,
    c.email,
    c.first_name,
    c.last_name,
    c.user_id AS keychain_uid,
    c.status,
    c.consent,
    c.tags,
    ob.last_step,
    ob.last_onboarding_at,
    ob.completed AS onboarding_completed,
    ob.account_created,
    pu.subscription_status,
    pu.app_trial_started_at,
    pu.app_trial_ends_at,
    pu.mt5_login IS NOT NULL AND pu.mt5_login <> ''::text AS mt5_connected,
    pu.first_setup_complete,
    pu.id IS NOT NULL AS purchase_linked,
    pu.meta_api_undeployed_at,
    c.country,
    c.locale,
    c.source,
    pu.billing_state,
    COALESCE(ob.blocked_apps_set, false) AS blocked_apps_set,
    ob.blocked_apps_set_at,
    pu.license_code IS NOT NULL AS has_license,
    pu.license_period_ends_at
   FROM email_contacts c
     LEFT JOIN LATERAL ( SELECT max(o.created_at) AS last_onboarding_at,
            (array_agg(o.step ORDER BY o.created_at DESC))[1] AS last_step,
            bool_or(o.step = 'onboarding_completed'::text) AS completed,
            bool_or(o.step = 'account_created'::text) AS account_created,
            bool_or(o.step = 'blocked_apps_set'::text) AS blocked_apps_set,
            max(o.created_at) FILTER (WHERE o.step = 'blocked_apps_set'::text) AS blocked_apps_set_at
           FROM onboarding_events o
          WHERE lower(o.user_id) = c.user_id) ob ON true
     LEFT JOIN purchases pu ON lower(pu.user_id::text) = c.user_id;
