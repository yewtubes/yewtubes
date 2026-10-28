# Coverage matrix

Every page, menu, dialog and workflow of the pinned YouTube desktop client and YouTube Studio, and how far this instance has got with each one. [remaining-work.md](../remaining-work.md) puts the gaps in order of priority. [endpoints.md](endpoints.md) maps each request to its handler.

## Statuses

| Status | Meaning |
| --- | --- |
| **not investigated** | Not yet captured from YouTube or looked at. |
| **captured** | The real page or request is captured (read-only, test or owner account) under `captures/` (gitignored), but nothing here serves it yet. |
| **implemented** | Served from templates and the database, but not checked end to end in a browser since the last change. |
| **browser verified** | Checked in Chromium against the pinned client: direct load, in-app navigation, refresh and back/forward where they apply, and persisted state after reload. |
| **blocked** | Can't be done faithfully yet. The reason is given in the last column. |

## Columns and evidence

- **Reached from**: where the client links to the page or calls the endpoint.
- **Auth**: out = signed out, in = signed in, op = operator.
- **Shell · data · API**: the pinned page shell (`kind`) and its `ytInitialData` / InnerTube methods.
- **Loads**: D direct load, I in-app navigation, R refresh, H back/forward. ✓ works, ✗ fails, – doesn't apply.
- **Evidence** names the browser check:

| Evidence | Script |
| --- | --- |
| e2e:core | [`scripts/e2e/core.ts`](../../scripts/e2e/core.ts) |
| e2e:playback | [`scripts/e2e/playback.ts`](../../scripts/e2e/playback.ts) |
| e2e:accounts | [`scripts/e2e/accounts.ts`](../../scripts/e2e/accounts.ts) |
| e2e:gifs | [`scripts/e2e/gifs.ts`](../../scripts/e2e/gifs.ts) |
| e2e:upload | [`scripts/e2e/upload.ts`](../../scripts/e2e/upload.ts) |
| e2e:shorts | [`scripts/e2e/shorts.ts`](../../scripts/e2e/shorts.ts) |
| survey | [`scripts/research/route-status.ts`](../../scripts/research/route-status.ts) (main site) and [`studio-walk.ts`](../../scripts/research/studio-walk.ts) (Studio). These report each page's data shape, alerts, unhandled methods and failed requests, signed out and signed in. |
| manual | Checked by hand in a browser during development. |

## Main client: pages

| Route | Reached from | Auth | Shell · data · API | Persisted state | Loads D/I/R/H | Status | Evidence | Missing / blockers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/` Home | logo, guide | out, in | home · `FEwhat_to_watch` richGrid · `browse` continuation | — | ✓✓✓✓ | browser verified | e2e:core, survey | Topic chips, Shorts shelf, personalised ranking |
| `/results?search_query=` | masthead search | out, in | results · `search`, `/complete/search` | search history for signed-in viewers | ✓✓✓✓ | browser verified | e2e:core, survey | — |
| `/results` filters (`sp=`) | Filters dialog | out, in | `search` with `params` | — | ✓✓✓✓ | browser verified | manual | — |
| `/watch?v=` | everywhere | out, in | watch · `next`, `player`, `get_watch`, `/videoplayback` | history, resume position, start time (`t=`, `playbackStartConfig`) | ✓✓✓✓ | browser verified | e2e:core, e2e:playback | Captions, chapters, storyboards, end screens. In-page navigation autoplays even when the player script loads after the click (patch `player-first-party-host`) |
| `/watch?v=&list=` | playlist Play all | out, in | watch · `next` playlist panel | — | ✓✓✓✓ | browser verified | manual | — |
| `/@handle`, `/channel/UC…` Home / Videos / Playlists | owner links, search | out, in | channel · `browse UC…` with tabs, About panel continuation | — | ✓✓✓✓ | browser verified | e2e:core, manual | — |
| Channel Shorts / Live / Posts / Store / search tabs | channel tabs | out, in | channel · `browse UC…` params | — | – | captured | site-in `47-…` | Tabs are left out of the template until they have data |
| `/playlist?list=` | lockups, guide | out, in | playlist · `browse VL…` | playlists table | ✓✓✓✓ | browser verified | manual, survey | — |
| `/playlist?list=WL`, `LL` | guide, You | in | playlist · `browse VLWL` / `VLLL` | watch_later, ratings | ✓✓✓✓ | browser verified | e2e:core, survey | — |
| `/playlist?list=WL` signed out | guide | out | — | — | ✗ | implemented | survey | Answers 404; YouTube shows the playlist page with a sign-in alert |
| `/feed/subscriptions` | guide | in | browse · `FEsubscriptions` | subscriptions, watch_history (progress bars) | ✓✓✓✓ | browser verified | survey, manual | Shorts on their own shelf two rows down ("View all" opens the Shorts page) |
| `/feed/subscriptions/shorts` | Subscriptions' Shorts shelf "View all" | in | browse · `FEsubscriptions_shorts` | subscriptions | ✓✓✓✓ | browser verified | manual | — |
| `/feed/subscriptions` signed out | guide | out | browse · sign-in promo | — | ✓✓✓✓ | browser verified | survey | — |
| `/feed/you` | guide | out, in | browse · `FEyou` (sign-in promo when out) | — | ✓✓✓✓ | browser verified | survey | — |
| `/feed/history` | guide, You | out, in | browse · `FEhistory`, `feedback` (remove, clear, pause, turn on) | watch_history, users.history_paused, videos.category_id | ✓✓✓✓ | browser verified | e2e:core, survey | All/Videos/Shorts/Music chips, each day's Shorts in a reel shelf. The paused toggle ("Turn on watch history") has no capture: it acts without a confirm dialog. My Activity links lead to `/myaccount/activity`. Search history view (`?view=search`) shows watch history |
| `/feed/playlists` | guide, You | in (out → sign-in) | browse · `FEplaylist_aggregation` | playlists, saved playlists | ✓✓✓✓ | browser verified | survey | — |
| `/feed/channels` | guide | in (out → sign-in) | browse · `FEchannels` | subscriptions | ✓✓✓✓ | browser verified | survey | — |
| `/feed/downloads` | guide (hidden) | in | — | — | ✗ | captured | site-in `11-…` | Needs the offline Downloads page; hidden from the guide until served |
| `/shorts/<id>` | Shorts links, the next Short (↓) | out, in | shorts · `reel/reel_item_watch` data + `ytInitialReelWatchSequenceResponse` (the following Shorts) · `player` | videos (vertical or square, ≤ 3 min, public, ready) | ✓✓✓✓ | browser verified | e2e:shorts, manual (light, dark, phone width) | A video that isn't a Short redirects to the watch page, as YouTube does; Shorts with music, remix and the sound page are left out (no audio library) |
| `/shorts/` | guide > Shorts | out, in | shorts · newest Short + `replacementEndpoint` + `sequenceContinuation` → `reel/reel_watch_sequence`; in-app: seedless `reel/reel_item_watch` | — | ✓✓✓✓ | browser verified | e2e:shorts | Ordering is newest first, not personalised |
| Shorts player: like, subscribe (signed-out sign-in prompt), share (`/shorts/` link) | reel action bar | out, in | `like/like`, `subscription/subscribe`, `share/get_share_panel` | video_reactions, subscriptions | – | browser verified | e2e:shorts | No dislike in this build's Shorts action bar (as captured) |
| Shorts comments panel | comments button | out, in | `browse` continuation (`FEcomment_shorts…` on YouTube; our token `k: comments, t: s`) into `shorts-engagement-panel-comments-section`; header is the composer only | comments | – | browser verified | e2e:shorts, captures `shorts-comments` | Replies, likes and deleting go through the same handlers as the watch page |
| Shorts description panel | title | out, in | in `reel_item_watch` (title, channel, likes/views/age factoids, description) | videos | – | browser verified | e2e:shorts | — |
| Shorts overflow menu (Description, Save, Full screen, Playback speed, Send feedback) | — | out, in | in `reel_item_watch` | — | – | captured | captures `shorts-menu` | The desktop client doesn't render this menu (neither on YouTube); kept in the data as YouTube sends it |
| `/channel/UC-9-kyTW8ZkZNDHQJ6FgpwQ` (Music), `/channel/UC4R8DWoMoI7CAwX8_LjQHig` (Live) | guide Explore (hidden) | out, in | — | — | ✗ | captured | site-in `12-…`, `13-…` | YouTube's own destination channels; need local equivalents |
| `/gaming`, `/podcasts`, `/playables` | guide Explore (hidden) | out, in | — | — | ✗ | captured | site-in `14-…`–`16-…` | Destination pages; hidden from the guide |
| `/feed/trending`, `/feed/explore` | old links | out, in | — | — | ✗ | captured | site-in `19-…`, `20-…` | YouTube now sends these to other destinations; to do |
| `/feed/news_destination`, `/feed/sports`, `/feed/courses`, `/feed/fashion_destination` | Explore | out, in | — | — | ✗ | captured | site-in `21-…`–`24-…` | Destination pages |
| `/feed/storefront` (Movies) | Explore | out, in | — | — | ✗ | captured | site-in `25-…` | Nothing is sold here |
| `/channel_memberships` | guide (hidden) | in | — | — | ✗ | captured | site-in `17-…` | Memberships aren't offered; empty state to be served |
| `/reporthistory` | guide (hidden) | in | — | — | ✗ | captured | site-in `18-…` | Needs reporting first |
| `/feed/purchases`, `/paid_memberships` | account menu (left out) | in | — | — | ✗ | blocked | site-in `26-…`, `27-…` | The only capture is of an account with purchases, so the empty state is unknown |
| `/premium` | — | out, in | — | — | ✗ | captured | site-in `28-…` | Out of scope (Google's product) |
| `/hashtag/<tag>` | hashtags in descriptions | out, in | — | — | ✗ | captured | site-in `29-…` | Hashtag page from video descriptions |
| `/embed/<id>` | Share > Embed | out, in | — | — | ✗ | not investigated | — | Embedded player |
| `/signin`, `/register` | Sign in button | out | YewTube's own pages (Google-style) | users, sessions | ✓–✓✓ | browser verified | e2e:core | — |
| `/signin?add=1` | Switch account > Add account | in | own page | sessions (`OT_ACCOUNTS`) | ✓–✓✓ | browser verified | e2e:accounts | — |
| `/myaccount` | account menu "YewTube account", "Your data in YouTube" | in | own page | users, sessions | ✓–✓✓ | browser verified | manual | — |
| `/myaccount/activity` (`/comments`, `/posts`, `/live-chat`) | History's "Manage all history", Comments, Posts, Live chat; the dialogs' My Activity links | in | own page (in place of Google's My Activity) | users.history_paused, watch_history, comments | ✓–✓✓ | browser verified | manual | Posts and live chat list nothing yet: the instance has no posts or live streams |
| `/feedback` | account menu Send feedback (main site and Studio) | out, in | own page | feedback | ✓–✓✓ | browser verified | e2e:accounts | — |

## Main client: settings (`/account*`)

All are browse `SPaccount_*` pages (page type `WEB_PAGE_TYPE_SETTINGS`, served in the home shell), built from captured templates (`settings/*`) with Google-only options left out. Signed out, a direct load goes to sign-in and an in-app `browse` gets 401 `unauthorized`, as on YouTube.

| Route | Auth | Persisted state | Loads D/I/R/H | Status | Evidence | Missing / blockers |
| --- | --- | --- | --- | --- | --- | --- |
| `/account` Account | in | — (links to Studio and `/myaccount`) | ✓✓✓✓ | browser verified | e2e:accounts | Family Center and Membership are left out |
| `/account_notifications` | in | `account_settings` items 223, 315, 182, 183, 308, 200, 463 | ✓✓✓✓ | browser verified | e2e:accounts | Settings are stored but no notifications are generated yet; desktop push and email are left out |
| `/account_playback` Playback and performance | in | info cards (294); preferred languages (`get_panel` `PApreferred_language_settings`, `submit_form`) | ✓✓✓✓ | browser verified | e2e:accounts, manual | Captions and AV1 choices are client-side (cookie / local storage) |
| `/account_privacy` | in | 19 (keep subscriptions private) | ✓✓✓✓ | browser verified | e2e:accounts | Only Subscriptions is kept; the choice decides whether Studio names the account among a channel's subscribers (e2e:studio-subscribers) but isn't applied to the channel page yet |
| `/account_sharing` Connected apps | in | — | ✓✓✓✓ | browser verified | e2e:accounts | Intro only: no connected apps exist |
| `/account_billing` | in | — | ✓✓✓✓ | browser verified | e2e:accounts | Intro only: nothing is sold |
| `/account_advanced` | in | — (User ID, Channel ID; Delete channel goes to `/myaccount#delete`) | ✓✓✓✓ | browser verified | e2e:accounts | — |
| `/account_downloads` | in | — | ✓✓✓✓ | browser verified | e2e:accounts | Download quality is client-side |
| `/account_time_management` | in | 10154, 10155 (Shorts timer) | ✓ | implemented | manual | — |
| `/account_performance` | in | — | ✗ | captured | site-in `33-…` | Old path; YouTube redirects it to Playback and performance |

## Main client: menus, dialogs and actions

| Feature | Reached from | Auth | API | Persisted state | Status | Evidence | Missing / blockers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Guide (side bar, mini guide, drawer) | hamburger | out, in | `guide` | subscriptions, playlists | browser verified | e2e:core, manual | Entries for unserved destinations are hidden (`UNSERVED` in `guide.ts`) |
| Account menu | avatar | out, in | `account/account_menu` | — | browser verified | e2e:accounts | Purchases and memberships left out (see above) |
| Switch account | account menu | in | `GET /getAccountSwitcherEndpoint`, `/signin?action_handle_signin=true&authuser=N` | `OT_ACCOUNTS` (up to 10 accounts per browser) | browser verified | e2e:accounts | — |
| Sign out (all accounts on the browser) | account menu, switcher | in | `/logout` | sessions | browser verified | e2e:accounts | — |
| Appearance (device, dark, light) | account menu | out, in | client-side, `PREF` cookie | PREF | browser verified | e2e:core | — |
| Display language, Location | account menu | out, in | client-side (`hl`, `gl`) | — | implemented | manual | Only English is served; other languages would need their string bundles pinned |
| Restricted Mode | account menu | out, in | client-side | PREF | not investigated | — | Nothing is filtered yet |
| Keyboard shortcuts | account menu | out, in | client-side | — | browser verified | manual | — |
| Create > Upload video | masthead | in | opens Studio's upload dialog | — | browser verified | e2e:upload | Go live and Create post are left out |
| Notifications bell | masthead | in | `notification/get_unseen_count`, `browse FEnotifications_inbox` | — | implemented | manual | Inbox is always empty |
| Like / dislike | watch | in | `like/*` | ratings | browser verified | e2e:core | — |
| Subscribe / unsubscribe, bell preference | watch, channel | in | `subscription/*`, `notification/modify_channel_preference` | subscriptions | browser verified | e2e:core | The bell preference isn't stored |
| Comments: post, reply, like, sort, delete own | watch | in (read: out) | `comment/*`, `next` continuations | comments, comment_likes | browser verified | e2e:core, manual | Pin, edit, report |
| Creator hearts and held comments on the watch page | watch | out, in | `next` continuations (`toolbar.creatorThumbnailUrl`, `heartState`) | comments.hearted_at, spam_at | browser verified | e2e:studio-comments (a held comment is absent), manual 2026-10-23 (heart with the channel's avatar) | — |
| GIFs in comments | comment box | in | `/_ot/gifs/*`, `comment/create_comment` | comments.gif, gif_favorites | browser verified | e2e:gifs | Needs `KLIPY_API_KEY` |
| Comment emoji picker | comment box | in | — | — | not investigated | — | The client's emoji data needs pinning |
| Save to playlist sheet, Watch later, New playlist | watch, lockup menus | in | `get_panel PAadd_to_playlist`, `browse/edit_playlist`, `playlist/create` | playlists | browser verified | e2e:core, manual | — |
| Playlist edit: rename, describe, privacy, reorder, remove, delete, save others' | playlist page | in | `browse/edit_playlist`, `playlist/delete`, `like/like` | playlists | browser verified | manual | Collaborators, sort options |
| Share panel | watch | out, in | `share/get_share_panel` | — | browser verified | manual | Embed tab |
| Add to queue | lockup menus | out, in | client-side | — | implemented | manual | — |
| Clips, Thanks, Download, Report, Ask | watch | in | — | — | not investigated | — | — |
| Live chat, premieres | watch | out, in | — | — | not investigated | — | Needs live streaming |

## YouTube Studio

Studio runs on its own origin. Signed-out visitors are sent to the main origin's sign-in; another channel's URL redirects to your own.

| Route / feature | Reached from | API | Persisted state | Status | Evidence | Missing / blockers |
| --- | --- | --- | --- | --- | --- | --- |
| Shell, left nav, appearance (light, dark, device) | account menu > YouTube Studio | Studio pin (normal and dark builds) | PREF | browser verified | e2e:core, manual | — |
| Account menu (Your channel, YouTube, Switch account, Sign out, Appearance, Send feedback) | avatar | `account/account_menu` (template `account/studio_menu`) | — | browser verified | e2e:accounts | — |
| Switch account | Studio account menu | `GET /getAccountSwitcherEndpoint` on the Studio origin | `OT_ACCOUNTS` | browser verified | e2e:accounts | — |
| Dashboard | nav | `creator/get_channel_dashboard`, analytics queries | stats tables | browser verified | manual 2026-10-23 (bob: "Latest Short performance" with ranking 1 of 4, views 40, average view duration; summary through yesterday; top content over 48 hours; Latest comments lists the newest unanswered comments, and View more opens Comments filtered to Unresponded: e2e:studio-comments; Recent subscribers names the last 90 days' public subscribers, and See all opens the Subscribers dialog with Subscribe back: e2e:studio-subscribers) | Members (no memberships) |
| Upload dialog: transfer, details, visibility, publish, processing | Create > Upload | `/upload/studio`, `upload/createvideo`, `video_manager/metadata_update`, `upload/feedback` | videos, media | browser verified | e2e:upload, manual | Checks run nothing ("Checks complete") |
| Content > Videos: list, sort, paging, delete one or many | nav | `creator/list_creator_videos`, `video/delete`, bulk delete | videos | browser verified | e2e:core, manual | Views column shows "–"; filters; bulk edit |
| Content > Videos / Shorts split | nav | `creator/list_creator_videos` with `contentTypeIs CREATOR_CONTENT_TYPE_SHORTS` (Shorts) or its negation (Videos), evaluated per video | videos | browser verified | manual 2026-10-23 (bob: Videos lists the two landscape videos, Shorts the two portrait ones) | — |
| Content > Live | nav | `creator/list_creator_videos` | — | implemented | survey | No live streams exist |
| Content > Playlists (`/content/playlists`) | Content tabs | `creator/list_creator_playlists` | playlists | implemented | survey 2026-10-23: no errors | Create and edit in Studio |
| Content > Posts (`/content/posts`) | Content tabs | `post/list_creator_posts` | — | captured | survey: unhandled | No posts exist yet |
| Content > Podcasts, Collaborations (`/content/podcasts`, `/videos/collaboration`) | Content tabs | — | — | implemented | survey: no errors, no unhandled methods | Empty states not compared with YouTube |
| Content > Promotions (`/content/promotions`) | Content tabs | `promotions/get_account` | — | implemented | survey: one illustration 404 (`creator/promotions/preview_background_home_v2.svg`) | Ads are a Google service: blocked beyond the empty state |
| Inspiration / Ideas (`/content/inspiration`) | nav | `creator/list_video_ideas` | — | captured | survey: unhandled | YouTube's suggestions are Google's models: blocked beyond an empty list |
| Note | — | — | — | — | — | Studio throws "Nn`" for URLs missing from its route table (`/videos/posts` and the like, which an earlier survey used); the paths above are the route table's |
| Analytics: Overview (headline, views, watch time, subscribers, top content, realtime 48 hours) | nav | `yta_web/get_screen`, `yta_web/get_cards` (templates `studio/analytics_*`) | stats tables, subscriptions | browser verified | e2e:analytics; manual 2026-10-23 light, dark | Narrow widths overflow (Studio is a desktop layout) |
| Analytics: Content (Videos and Shorts sections) | Analytics tabs | `yta_web/get_screen`, `yta_web/get_cards` | stats tables | browser verified | e2e:analytics | Opening `tab-content` directly leaves no section chosen until one is clicked (in-app navigation picks Videos). The Shorts section's card arrangement follows the Videos one; the capture had no Shorts. Impressions, traffic sources and returning viewers are not recorded: their tabs are left out, their cards show YouTube's no-data state |
| Analytics: Audience | Analytics tabs | `yta_web/get_screen`, `yta_web/get_cards` | channel stats | browser verified | e2e:analytics | Subscribers chart is real; demographics, watch behaviour, viewer times, other channels and formats are not recorded and show YouTube's no-data states |
| Analytics: Trends (research) | Analytics tabs | `yta_web/get_screen` | — | implemented | manual 2026-10-23 | Shows YouTube's starter ideas; searching for ideas uses YouTube's search data: blocked |
| Analytics periods (Last 28 days, Lifetime, …) | period menu | `screenConfig.timePeriod` | — | browser verified | e2e:analytics (Lifetime); manual | Days end today (figures are current to the hour); YouTube's end yesterday |
| Video analytics | video nav | `yta_web/get_screen` (entity `videoId`) | — | captured | survey | No capture of a video's analytics layout; not served |
| Video details: title, description, visibility | Content row | `creator/get_creator_videos`, `video_manager/metadata_update` | videos | browser verified | manual | Thumbnail upload, playlists, audience, tags, category, language, license, comments settings, scheduling |
| Video comments | video nav | `comment/get_comments` with `videoId` (Studio route) | comments | browser verified | e2e:studio-comments | `check_creator_comments_bulk_action` gets an empty answer (bulk actions run at once) |
| Video subtitles | video nav | `crowdsourcing/get_video_translations`, `creator/get_supported_content_languages` | — | captured | survey: unhandled | — |
| Video editor | video nav | `video_editor/*` (6 methods), `creator/list_creator_info_cards`, `creator/get_creator_endscreens` | — | captured | survey: unhandled; one illustration 404 | — |
| Video copyright | video nav | `creator/list_creator_received_claims` | — | captured | survey: unhandled | No checking system exists; must not report checks as done |
| Video details extras | edit page | `get_creator_social_suggestions`, `feature_eligibility/check_feature_rate_limit` | — | captured | survey: unhandled | — |
| Community: comments (Published, Held; Unresponded/Responded, questions, search, content type, sort; paging) | nav | `comment/get_comments`, `get_comment_replies` (Studio routes, [`studio/comments.ts`](../../src/studio/comments.ts)) | comments | browser verified | e2e:studio-comments, manual 2026-10-23 (bob) | Pin; Held lists only comments the channel reported (no automatic holding); follow-up and Super Thanks categories match nothing; the batch heart is behind a flag the pinned build leaves off |
| Comment actions: reply, edit own, like, heart, remove, report as spam, approve; selection with the batch bar | comment row | `comment/create_comment_reply`, `update_comment`, `update_comment_reply`, `perform_comment_action` (Studio routes) | comments, comment_reactions | browser verified | e2e:studio-comments | A removed reply leaves the thread's "1 reply" toggle until the page reloads |
| Subtitles | nav | `crowdsourcing/list_video_translations`, `get_video_translations`, `creator/get_supported_content_languages` | — | captured | survey: unhandled | — |
| Copyright | nav | `copyright/list_complaint_videos` | — | captured | survey: unhandled; one icon 404 | — |
| Earn (`/monetization`, `/monetization/overview`) | nav | — | — | captured | survey: no errors, no unhandled methods | Content not checked |
| Customization (profile, layout) | nav | `channel_edit/get_channel_page_settings` | channels | captured | survey: unhandled | `/editing/sections` redirects to `/editing/profile` |
| Audio library | nav | `creator_music/list_tracks` | — | captured | survey: unhandled | No audio library exists |
| Content detection | nav | left-nav link to the copyright route (`/copyright`) | — | captured | — | `/content_detection` is not a Studio route |
| Settings dialog | nav | — | — | captured | studio-all | Upload defaults, permissions, community |
| Send feedback (left nav) | nav | Google's feedback loader → stand-in `/_ot/help.js` | feedback | browser verified | manual | Opens the main origin's `/feedback` with the Studio page attached |
| Help button | masthead | Google's help service → stand-in | — | browser verified | manual | Opens YouTube's help center (Studio's article for the page when it names one) |

## Admin panel

| Feature | Auth | Status | Evidence |
| --- | --- | --- | --- |
| Operator-only access (404 for anyone else), signed-out redirect | op | browser verified | e2e:core, manual |
| Overview, Accounts, Videos, Processing, Compatibility, Feedback, Settings, Audit log | op | browser verified | manual |
| Feedback: open and resolved lists, resolve and reopen (audited) | op | browser verified | manual |
| Light, dark and device appearance shared with the client | op | browser verified | manual |
| Phone layout | op | browser verified | manual |
| Account marks: verification badge, Premium logo | op | browser verified | manual |
