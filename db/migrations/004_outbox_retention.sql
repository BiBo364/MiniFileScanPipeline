CREATE INDEX IF NOT EXISTS scan_outbox_published_idx
  ON scan_outbox (published_at)
  WHERE published_at IS NOT NULL;
