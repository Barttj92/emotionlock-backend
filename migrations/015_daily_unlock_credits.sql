-- 015: emergency unlock credits per day (trade mode).
-- An emergency unlock lowers tradesCount by one. That was kept in memory only,
-- so a backend restart locked the user again and the token was wasted.
-- Additive and nullable-safe: the backend tolerates these columns being absent.
alter table public.purchases
  add column if not exists daily_unlock_credits integer not null default 0,
  add column if not exists daily_unlock_date text;
