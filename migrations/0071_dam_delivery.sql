-- Private source identity and remote progress for create-only DAM deliveries.
alter table deliveries add column project_source jsonb;
alter table deliveries add column provider_progress jsonb;
