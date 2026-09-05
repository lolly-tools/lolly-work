-- A retained automation output's own digest. Blob-provider metadata is not a
-- portable substitute: an S3 ETag may be MD5 or a multipart composite.
alter table automation_jobs add column result_sha256 text;

alter table automation_jobs add constraint automation_jobs_result_sha256_shape
  check (result_sha256 is null or result_sha256 ~ '^[0-9a-f]{64}$');
