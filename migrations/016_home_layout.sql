-- the Home tab's layout from Studio's Customization > Home tab: whether the
-- tab shows, and its sections in order as Studio defines them
-- (predefinedShelfDefinition, playlistShelfDefinition, ...); null keeps
-- the default layout
alter table channels add column if not exists home_tab_enabled boolean not null default true;
alter table channels add column if not exists home_shelves jsonb;
