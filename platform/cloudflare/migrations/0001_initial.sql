CREATE TABLE IF NOT EXISTS translation_cache (
  cache_key TEXT PRIMARY KEY,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  detected_source_lang TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_translation_cache_expires_at
ON translation_cache(expires_at);

CREATE TABLE IF NOT EXISTS translation_jobs (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  response_type TEXT NOT NULL CHECK(response_type IN ('deeplx', 'official')),
  request_json TEXT NOT NULL,
  colo TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'succeeded', 'failed', 'expired')),
  result_json TEXT,
  error_json TEXT,
  lease_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  deadline_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_translation_jobs_status_deadline
ON translation_jobs(status, deadline_at);

CREATE INDEX IF NOT EXISTS idx_translation_jobs_retain_until
ON translation_jobs(retain_until);
