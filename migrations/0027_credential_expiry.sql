-- lolly-work schema - provider credential expiry (plans/36 §2).
--
-- OAuth refresh tokens and vendor API keys die on schedules only the
-- operator knows, and until now the first sign was a failing sync. The
-- operator can STATE the date when the credential is entered; the product
-- keeps it visible (provider rows, the console chip, the
-- lw_provider_credential_expiry_days gauge) and the daily check notifies
-- owners as thresholds pass. Optional by design: absent means unknown, and
-- nothing nags about what was never stated.

alter table catalog_providers add column credential_expires_at timestamptz;
