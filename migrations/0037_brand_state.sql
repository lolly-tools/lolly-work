create table brand_state (
  singleton boolean primary key default true check (singleton),
  revision bigint not null default 0 check (revision >= 0),
  state jsonb not null
);
insert into brand_state (singleton, revision, state) values (true, 0,
  '{"activeSource":null,"retired":[],"download":{"suppressed":false,"sourceId":null,"sourceRevision":null,"blobId":null,"meta":null}}');
