-- Keep permanent request receipts; only the large response cache may be removed.
-- These statements run at every startup, so backfill only missing metadata.
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS committed_revision integer;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS response_expires_at timestamptz;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS response_bytes integer NOT NULL DEFAULT 0;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS audit_event_id text REFERENCES audit_events(id);
UPDATE idempotency_keys
SET committed_revision=(response->>'revision')::integer,
    response_expires_at=created_at+interval '24 hours',
    response_bytes=octet_length(response::text)
WHERE committed_revision IS NULL AND response IS NOT NULL;
ALTER TABLE idempotency_keys ALTER COLUMN committed_revision SET NOT NULL;
ALTER TABLE idempotency_keys ALTER COLUMN response_expires_at SET NOT NULL;
ALTER TABLE idempotency_keys ALTER COLUMN response DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idempotency_cached_workspace ON idempotency_keys(workspace_id,committed_revision DESC,key DESC) WHERE response IS NOT NULL;
CREATE INDEX IF NOT EXISTS idempotency_cached_expiry ON idempotency_keys(response_expires_at,workspace_id) WHERE response IS NOT NULL;

-- Apply the initial cache budget once, including pre-existing large caches.
-- Never reset TTLs or reconstruct a response that has already been compacted.
WITH ranked AS (
  SELECT workspace_id,key,
         row_number() OVER (PARTITION BY workspace_id ORDER BY committed_revision DESC,key DESC) AS position,
         sum(response_bytes) OVER (PARTITION BY workspace_id ORDER BY committed_revision DESC,key DESC) AS bytes
  FROM idempotency_keys
  WHERE response IS NOT NULL AND response_expires_at>now()
    AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=4)
), compact AS (
  SELECT workspace_id,key FROM ranked WHERE position>32 OR bytes>33554432
  UNION ALL
  SELECT workspace_id,key FROM idempotency_keys
  WHERE response IS NOT NULL AND response_expires_at<=now()
    AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=4)
)
UPDATE idempotency_keys AS receipts SET response=NULL,response_bytes=0
FROM compact WHERE receipts.workspace_id=compact.workspace_id AND receipts.key=compact.key;
INSERT INTO schema_migrations(version) VALUES (4) ON CONFLICT DO NOTHING;
