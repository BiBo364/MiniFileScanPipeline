CREATE TABLE IF NOT EXISTS scan_outbox (
  id UUID PRIMARY KEY,
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  CONSTRAINT scan_outbox_scan_event_unique UNIQUE (scan_id, event_type)
);

CREATE INDEX IF NOT EXISTS scan_outbox_pending_idx
  ON scan_outbox (created_at)
  WHERE published_at IS NULL;

INSERT INTO scan_outbox (id, scan_id, event_type, payload)
SELECT
  gen_random_uuid(),
  scans.id,
  'scan.queued',
  jsonb_build_object(
    'scanId', scans.id,
    'sha256', scans.sha256,
    'filePath', scans.stored_path
  )
FROM scans
WHERE scans.status = 'Queued'
ON CONFLICT (scan_id, event_type) DO NOTHING;
