-- YouTube's Communities: a channel opens one from Studio's Viewer posts
-- setting (commentsSettings.viewerPostSettings, as Studio sends it), and
-- its viewers' posts belong to that community rather than their own channel
alter table channels add column viewer_posts jsonb;
alter table posts add column community_channel_id text references channels on delete cascade;
create index posts_community on posts (community_channel_id, published_at desc) where deleted_at is null and community_channel_id is not null;
