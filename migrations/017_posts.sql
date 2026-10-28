-- A channel's posts (the Posts tab, /post/<id>): text with at most one
-- attachment, as the client's composer creates them (backstage/create_post):
--   {"video": "<video id>"}
--   {"images": [{"file": "<name>", "width", "height"}, ...]}
--   {"poll": {"choices": ["…", …]}}            text poll
--   {"imagePoll": {"choices": [{"text", "file", "width", "height"}, …]}}
--   {"quiz": {"choices": [{"text", "correct", "explanation"}, …]}}
-- Ids have YouTube's shape (Ugkx and 32 more characters), so they fit the
-- protobuf blobs of YouTube's own post links and share entities.
create table posts (
	id text primary key,
	channel_id text not null references channels on delete cascade,
	text text not null default '',
	attachment jsonb,
	like_count integer not null default 0,
	comment_count integer not null default 0,
	created_at timestamptz not null default now(),
	edited_at timestamptz,
	deleted_at timestamptz
);
create index posts_channel on posts (channel_id, created_at desc) where deleted_at is null;

create table post_reactions (
	user_id bigint not null references users on delete cascade,
	post_id text not null references posts on delete cascade,
	kind text not null check (kind in ('like', 'dislike')),
	created_at timestamptz not null default now(),
	primary key (user_id, post_id)
);

-- a vote in a poll or an answer to a quiz (one per viewer)
create table post_votes (
	user_id bigint not null references users on delete cascade,
	post_id text not null references posts on delete cascade,
	choice integer not null,
	created_at timestamptz not null default now(),
	primary key (user_id, post_id)
);

-- comments belong to a video or to a post
alter table comments alter column video_id drop not null;
alter table comments add column post_id text references posts on delete cascade;
alter table comments add constraint comments_one_target check ((video_id is null) <> (post_id is null));
create index comments_post on comments (post_id, created_at desc) where parent_id is null;
