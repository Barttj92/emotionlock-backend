-- 013_activation_month_release_day.sql
-- RUN ON iOS RELEASE DAY (the day the app version with the activation month
-- goes live), not before: older app builds still paywall license holders
-- locally, so running this earlier would burn their 30 days while they are
-- still locked out.
--
-- Gives every current license holder without an active subscription a fresh
-- 30-day activation month from today. They paid for the license under the
-- old two-step flow and never got access. GREATEST keeps any later end date
-- a license bought after the backend deploy already has.

-- 1) Backfill current license holders.
UPDATE public.purchases
SET license_period_ends_at = GREATEST(COALESCE(license_period_ends_at, now()), now() + interval '30 days'),
    activation_notified_3d_at = NULL,
    activation_notified_1d_at = NULL
WHERE license_code IS NOT NULL
  AND COALESCE(subscription_status, '') NOT IN ('active', 'trialing');

-- 2) Turn on the two activation-month emails (created inactive on 2026-10-29).
UPDATE public.email_automations
SET is_active = true, updated_at = now()
WHERE key IN ('C8_activation_ending', 'C9_activation_ended');

-- 3) Conversion and winback emails: say the activation now includes the
--    first month. Only touches templates that still have the old sentence.
UPDATE public.email_templates
SET html_body = replace(html_body, 'for a limited time.', 'for a limited time, and it includes your first month of full access.'),
    text_body = replace(text_body, 'for a limited time.', 'for a limited time, and it includes your first month of full access.'),
    updated_at = now()
WHERE key IN ('C3_trial_ending_24h_4day_en', 'trial_ended_high', 'winback')
  AND text_body NOT ILIKE '%first month of full access%';

UPDATE public.email_templates
SET html_body = replace(html_body, 'voor beperkte tijd.', 'voor beperkte tijd, inclusief je eerste maand volledige toegang.'),
    text_body = replace(text_body, 'voor beperkte tijd.', 'voor beperkte tijd, inclusief je eerste maand volledige toegang.'),
    updated_at = now()
WHERE key IN ('C3_trial_ending_24h_4day_nl', 'trial_ended_high_nl', 'winback_nl')
  AND text_body NOT ILIKE '%eerste maand volledige toegang%';
