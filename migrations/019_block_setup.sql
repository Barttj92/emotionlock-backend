-- 019: blocking setup reported by the iOS app.
-- The app sends X-Block-Setup on every /status call: Screen Time authorisation,
-- number of selected apps and categories, MT5 blocked by bundle id, and whether
-- a shield is applied right now. The backend stores it when it changes, so
-- support can see whether a lock really blocks anything on the user's iPhone.
-- Counts only, never app identities. Additive: the backend tolerates these
-- columns being absent.
alter table public.purchases
  add column if not exists block_setup jsonb,
  add column if not exists block_setup_at timestamptz;
