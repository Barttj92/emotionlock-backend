-- 020: when the user was last told that their MT5 connection dropped.
-- The trade poller sends a push and a mail when a MetaAPI account stays
-- disconnected for 20 minutes, at most once per 24 hours per user. Stored here
-- so a backend restart does not send the same warning again. Additive: the
-- backend tolerates the column being absent (it then falls back to memory).
alter table public.purchases
  add column if not exists mt5_disconnect_notified_at timestamptz;
