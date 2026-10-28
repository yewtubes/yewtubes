# Patch inventory

Every change YewTube makes to what YouTube served. The archived files in `client/original/` are never modified; these edits happen when an asset or page is served. `bun run check-patches` reports each patch's match count and exits non-zero when a count differs from the expected one. The admin panel's Compatibility page shows the same results for the running instance.

Keep this file in sync with [`src/client/patches.ts`](../src/client/patches.ts), [`src/client/page.ts`](../src/client/page.ts) and [`src/studio/page.ts`](../src/studio/page.ts).

## Asset patches

Applied to JavaScript and CSS on the way out. A patch whose match count differs from **Expect** is not applied: the asset is served unpatched and the failure is reported.

| Patch | Asset | Expect | Why |
| --- | --- | --- | --- |
| `icons-material-host` | app | 2 | The icon manager builds SVG icon URLs from this literal prefix (functions MM9/A_9 in this build). Points them at the instance's archived copies instead of fonts.gstatic.com. |
| `gstatic-youtube-img-host` | app | 60 | Every www.gstatic.com/youtube/img/ URL the app names, across the main bundle and lazy modules: the second icon family (icons/web/, function euN), Lottie animations (like, subscribe, loading), and illustrations. Points them at the archived copies under /_up/. |
| `icons-allowed-hosts` | app | 1 | The icon manager only fetches and inlines .svg icons whose URL starts with one of these origins (pUs). Adds the instance origin so the relocated icons above are inlined like upstream ones. |
| `player-trusted-stream-host` | player | 1 | non-localhost origins only. The player refuses media URLs ('Untrusted URL') unless they match its stream allowlist or start with http://local / https://local. A localhost instance needs nothing; any other host is added to the allowlist's host alternation. |
| `player-trusted-image-host` | player | 1 | The player keeps only thumbnail URLs on its trusted image hosts (videoDetails.thumbnail -> poster, miniplayer, end screen); for anything else it builds http(s)://i1.ytimg.com/vi/<id>/... itself. Adds the instance host so it uses this instance's thumbnails. |
| `player-first-party-host` | player | 1 | A page may set the player's event label (`el=detailpage` on the watch page) only if its URL is on this allowlist (youtube.com and Google's sites); on any other host the player takes itself for an embed, and embeds don't autoplay. It shows when the player script loads after a watch page has started (a search result clicked right after the page renders): the video was cued instead of played. Adds the instance host. |
| `player-base-host` | player | 1 | The player derives its base URL from the page location only if the host is on this allowlist, else uses www.youtube.com. That base URL hosts the QoE stats (/api/stats/qoe) and ptracking beacons. Adds the instance host so those go to this instance. |
| `fonts-stylesheet-host` | app | 5 | The app inserts five font stylesheets (italic Roboto, Roboto Mono, a games font) at run time from fonts.googleapis.com. Points them at the archived copies; the page's own stylesheet link is rewritten by the page renderer. |
| `no-redirect-prefetch` | app | 1 | On every load the app fetches https://youtube.com once to warm the youtube.com -> www redirect. Nothing to warm here; the list is emptied. |
| `app-help-service` | app | 1 | Google's in-product help and feedback service, loaded by URL when the client opens help or feedback. Points it at this instance's stand-in (`/_ot/help.js`, [assets/help.js](../assets/help.js)): feedback opens `/feedback`, help opens YouTube's help center. |
| `picker-rpc-script` | app | 1 | The post composer's Video button opens a picker dialog that talks to its frame over gadgets.rpc, loaded from apis.google.com. Loads the instance's gadgets.rpc instead (`/picker/rpc.js`, [src/picker.ts](../src/picker.ts)), which carries the same calls by postMessage. |
| `picker-plain-frame` | app | 1 | The picker dialog otherwise opens its frame through gapi.iframes and speaks Google Picker's protobuf commands. Turned off, it uses its plain-iframe path, which needs only gadgets.rpc. |
| `picker-frame-scheme` | app | 1 | Only for an instance served over plain http: the picker dialog forces its frame URL (`ONE_PICK_URL`, the instance's `/picker`) to https; it keeps http. |
| `studio-gstatic-youtube-img-host` | studio | 1004 | Studio's illustrations, icons and animations, named in string literals and in its Polymer templates' attribute bindings. Points them at the archived copies under the Studio origin's /_up/. |
| `studio-css-gstatic-host` | Studio stylesheet | 10 | Background images in Studio's stylesheet (onboarding and partner-program artwork). |
| `studio-icons-material-host` | studio | 2 | The prefix Studio's icon manager builds SVG icon URLs from, as in the main app. |
| `studio-icons-allowed-hosts` | studio | 1 | Studio's icon manager has the same origin allowlist as the main app's; adds the Studio origin so the relocated icons are fetched and inlined. |
| `studio-fonts-stylesheet-host` | studio | 4 | Font stylesheets Studio inserts at run time. |
| `studio-help-button` | studio | 1 | Studio's Help button loads Google's API loader (apis.google.com) before configuring help, which fails without Google's scripts. The button configures and opens help directly, through the stand-in. |
| `studio-feedback-direct` | studio | 1 | Send feedback first tries Google's newer feedback client and falls back to the classic one only on some errors. Goes straight to the classic path, which calls the stand-in's `GOOGLE_FEEDBACK_START`. |
| `studio-help-service` | studio | 3 | Studio preloads Google's help and feedback service on every page (its CSP refuses it) and loads Google's help API for the Help button. All three URLs point at the instance's stand-in: Send feedback opens the main origin's `/feedback`, help opens YouTube's help center. |

## Page shell rules (main client)

[`renderPage`](../src/client/page.ts) fills the pinned page for each URL. Rules marked optional may legitimately match nothing in some builds; any other rule that misses is reported.

| Rule | Change |
| --- | --- |
| `ytcfg` | The bootstrap configuration: instance origin, signed-in state, page kind, appearance (`userInterfaceTheme`, `ALT_PREF_COOKIE_DOMAIN`), player paths, and the flag overrides below. |
| `ytInitialData`, `ytInitialPlayerResponse` | This page's data, as `browse` / `next` / `player` return it. |
| `server-contract` | `ytPageType`, `ytCommand`, `ytUrl` for this page. |
| `nonce` | This response's CSP nonce. |
| `theme` | `<html dark>` when the viewer's appearance resolves to dark. |
| `attestation` (optional) | Removes the BotGuard bootstrap call (`ytAtN`). |
| `passive-signin-iframe` (optional) | Removes the hidden Google sign-in frame. |
| `media-host-hints`, `thumbnail-preload`, `player-placeholder` (optional) | Removes preconnects to Google media hosts; points the preload and player placeholder at this instance's thumbnail. |
| `player-urls` (optional) | The pinned player build's path. |
| `static-host`, `fonts-host` | `www.youtube.com/s/` and `fonts.googleapis.com` URLs to this origin. |
| `title`, `meta-title`, `meta-description`, `social-meta` | This page's title and description with the instance name. |
| `image-src`, `page-keywords`, `structured-data`, `microdata`, `app-links` (optional) | Removes YouTube's own metadata, canonical links, app links and origin trials. |
| `gif-picker` (only with `KLIPY_API_KEY`, signed in) | Adds `<script src="/_ot/gifs.js">` first in `<head>`: the GIF button and picker for comment boxes ([`assets/gifs.js`](../assets/gifs.js)). Its fetch wrapper adds the picked GIF's signed token as `yewtubeGif` to `comment/create_comment` and `create_comment_reply`; nothing else in the client changes. |
| `guide-footer-links`, `copyright` | Removes YouTube's footer links (About, Press, Terms, ...) and hides the copyright line. |

## Experiment flags

Set over the pinned build's values in `ytcfg` ([`FLAG_OVERRIDES`, `PLAYER_FLAG_OVERRIDES`](../src/client/page.ts)); the same values apply to Studio.

| Flag | Value | Why |
| --- | --- | --- |
| `service_worker_enabled`, `kevlar_appshell_service_worker`, `service_worker_push_*` | false | No service worker; one surviving a client upgrade would serve old bundles. |
| `web_player_ads_control_config` | false | No ads are served. |
| `disable_biscotti_fetch_entirely_for_all_web_clients` | true | No advertising id fetch from doubleclick. |
| `mdx_load_cast_api_bootstrap_script` | false | No Chromecast bootstrap from gstatic. |
| `use_url_origin_for_desktop_web_suggest_requests` | true | Search suggestions from this origin's `/complete/search`. |
| player `html5_use_ump` | false | Plain byte ranges from `/videoplayback` instead of UMP. |
| player `html5_generate_content_po_token`, `html5_generate_session_po_token`, `html5_non_onesie_attach_po_token`, `html5_bandaid_attach_content_po_token`, `html5_attach_po_token_to_bandaid` | false | No BotGuard, so no proof-of-origin tokens. |

## Studio page rules

[`renderStudioPage`](../src/studio/page.ts) fills the sanitized Studio shell.

| Rule | Change |
| --- | --- |
| `ytcfg` | Studio's configuration for this instance and channel, with the pinned player's paths and the flag overrides above. |
| `nonce` | This response's CSP nonce. |
| `prefetch-entity`, `prefetch-data` | The viewer's channel id and the prefetched channel data Studio boots with. |
| `static-host`, `gstatic-host`, `fonts-host`, `font-files-host` | Studio, gstatic and Google Fonts URLs to this origin. |

## Not patched

- No InnerTube request or response format is changed in the client; the server answers in YouTube's own shapes.
- Features this instance does not have (ads, live chat, Shorts feed, notifications delivery, Premium) are not removed from the client. Their requests get empty responses and are listed as unhandled in the admin panel.
