-- When a post goes up: when it was created, or later for a post the
-- composer's "Schedule post" set. Until then only its channel sees it (the
-- Posts tab's Scheduled section).
alter table posts add column published_at timestamptz;
update posts set published_at = created_at;
alter table posts alter column published_at set not null, alter column published_at set default now();
drop index posts_channel;
create index posts_channel on posts (channel_id, published_at desc) where deleted_at is null;
