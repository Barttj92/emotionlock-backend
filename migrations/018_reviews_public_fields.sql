-- 018: public review fields for the website (D-040).
-- Additive only. Existing rows keep working; new columns are optional.
--   source      where the review came from, shown on the card for transparency
--   context     short label under the name, e.g. "FTMO trader"
--   featured    shown on the homepage
--   reviewed_at date the user gave the review (falls back to created_at)
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS source text
  CHECK (source IS NULL OR source IN ('website', 'app_store', 'email', 'whatsapp', 'instagram', 'tiktok', 'x', 'reddit', 'discord', 'in_app'));
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS context text CHECK (context IS NULL OR char_length(context) <= 60);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
UPDATE reviews SET source = 'website' WHERE source IS NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_public ON reviews (status, featured, created_at DESC);
