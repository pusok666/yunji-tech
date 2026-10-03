-- Independent sequence values preserve insertion order when a restore inserts
-- many movements in one SQL transaction (all created_at values are then equal).
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS sequence bigserial;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sequence bigserial;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS before_state jsonb;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS after_state jsonb;
CREATE INDEX IF NOT EXISTS receipt_workspace_sequence ON receipts(workspace_id,sequence);
CREATE INDEX IF NOT EXISTS stock_workspace_sequence ON stock_movements(workspace_id,sequence);
INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
