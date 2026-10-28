-- Pause watch history (History page): while paused nothing new is recorded
alter table users add column if not exists history_paused boolean not null default false;
-- a video's category (Studio's Category field; 22 is People & Blogs, YouTube's default)
alter table videos add column if not exists category_id integer not null default 22;
