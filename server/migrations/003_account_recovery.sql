ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credential_version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS auth_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  token_hash text UNIQUE NOT NULL,
  email_snapshot text NOT NULL,
  credential_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  sent_at timestamptz,
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','sent','failed'))
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_purpose ON auth_tokens(user_id,purpose,created_at);
CREATE TABLE IF NOT EXISTS auth_request_limits (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  next_allowed_at timestamptz NOT NULL
);
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
