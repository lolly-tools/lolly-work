-- lolly-work schema - blob usage per month for the offload trigger (plan 80
-- section 10). The pg BlobStore driver adds the bytes it reads from
-- instance_blobs to the current UTC month's row, so the monthly figure survives
-- restarts and sums every replica. The two notice columns record that the
-- administrator email for that month has gone out, so replicas and restarts
-- send it once. Aggregates only: no blob, person or request is recorded here.

create table instance_blob_months (
  month            text primary key,
  read_bytes       bigint not null default 0,
  stored_notice_at timestamptz,
  read_notice_at   timestamptz
);
