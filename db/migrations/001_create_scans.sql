CREATE TABLE IF NOT EXISTS scans (
  id UUID PRIMARY KEY,
  sha256 VARCHAR(64) NOT NULL,
  stored_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  status TEXT NOT NULL,
  result_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT scans_status_check CHECK (
    status IN ('Queued', 'Scanning', 'Clean', 'Malicious', 'Failed')
  )
);

CREATE INDEX IF NOT EXISTS scans_sha256_idx ON scans (sha256);
