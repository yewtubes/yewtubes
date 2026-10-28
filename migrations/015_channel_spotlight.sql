-- the Home tab's video spotlight, set in Studio's Customization > Layout:
-- the trailer non-subscribers see, and the featured video for returning
-- subscribers (with an optional title of its own)
alter table channels add column if not exists trailer_video_id text references videos(id) on delete set null;
alter table channels add column if not exists featured_video_id text references videos(id) on delete set null;
alter table channels add column if not exists featured_video_title text;
