alter table api_tokens add column if not exists expires_at timestamptz;
