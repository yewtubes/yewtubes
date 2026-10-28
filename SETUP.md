# Setting up and running YewTube

This is the operator's guide: what YewTube needs, how to start it, and how
uploads, thumbnails and channel images are processed and stored. The
[README](README.md) covers the project, its scope and the full configuration
table.

## Requirements

- [Bun](https://bun.sh/), a recent release.
- [PostgreSQL](https://www.postgresql.org/) with an empty database.
- [FFmpeg and FFprobe](https://ffmpeg.org/) on `PATH`, with `libx264`, `aac`,
  `libvpx-vp9` and `libopus`.
- Disk space for uploaded sources, encodes, thumbnails and the client archives.

## First start

```sh
bun install
createdb yewtube
export DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/yewtube'
bun scripts/fetch-client.ts --check
bun scripts/fetch-studio.ts --check
SEED_PASSWORD='a-local-test-password' bun run seed   # optional demo accounts and videos
bun run start
```

The main site is on `http://localhost:8080/` and Studio on
`http://localhost:8081/`. Migrations run on every start, so pulling a new
version and restarting is enough to upgrade the database. For development,
`scripts/dev-server.sh restart` restarts the server in the background and
logs to `data/server.log`.

## Configuration

Bun reads a `.env` file in the project root. The settings most operators
need:

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://yewtube:yewtube@localhost:5432/yewtube` | The database |
| `PUBLIC_ORIGIN` / `STUDIO_ORIGIN` | `http://localhost:8080` / `:8081` | The main site's and Studio's external origins |
| `COOKIE_DOMAIN` | unset | Parent domain when the two origins are different hosts |
| `MEDIA_DIR` | `data/media` | Uploads, encodes, thumbnails and channel images |
| `MAX_UPLOAD_BYTES` | 2 GiB | Largest upload |
| `PROCESSING_WORKERS` | `2` | Processing jobs run at once (plus one lane kept for new uploads) |
| `NO_WORKER` | unset | `1` starts no processing (for a second web process) |
| `KLIPY_API_KEY` | unset | Turns on GIFs in comments |

## How an upload is processed

An upload goes through Studio's resumable uploader to `/upload/studio`. The
video is registered by `upload/createvideo`; the file goes to processing
when both the last byte and the registration have arrived, in either order.
Whichever comes second hands the file over, exactly once
(`upload_transfers.attached_at`). A recovery pass at startup and every
minute hands over any complete transfer whose video still has no file, so an
upload can't stay at "Uploading".

Processing then runs in two stages from the `processing_jobs` queue:

1. **Publish** (seconds). An H.264 source (8-bit 4:2:0, up to 60 fps) is
   *remuxed*: its video stream is copied into a progressive MP4 with AAC
   audio (copied when the source has AAC), at YouTube's muxed itag for its
   height (18, 22 or 37). Any other source gets a fast 360p encode (itag 18).
   The thumbnails and three stills for Studio's picker are made from the
   source. The video is then **playable**: it plays, lists and searches
   while its status is still `processing`.
2. **Ladder** (background). The adaptive formats: H.264 and VP9 per rung up
   to the source's height, AAC (140) and Opus (251), and itag 18 if publish
   didn't make it. Each format is added as it lands; the video becomes
   `ready` at the end. If the ladder fails, the video stays up with what it
   has, and the error is kept on the video and its job.

Jobs are claimed with `for update skip locked` by `PROCESSING_WORKERS`
workers, plus one worker that only takes publish jobs, so a long ladder never
holds up a new upload. Ladder encodes run at a lower CPU priority (`nice`).
A job interrupted by a restart runs again on the next start.

On a 4-core machine, a 53-second 1080p60 H.264/AAC clip is playable about a
second after its transfer completes; its ladder takes a few minutes.

## Thumbnails

Each video has three stills, at a quarter, half and three quarters of its
length (`MEDIA_DIR/<videoId>/still1-3.jpg`). In Studio's video details, the
thumbnail picker shows them and offers **Upload file**: custom images (JPG,
PNG, GIF, BMP or WebP) go through the same resumable protocol to
`/upload/studiothumbnail`, are fitted into 1280x720, and are kept as
`MEDIA_DIR/<videoId>/custom.jpg`. Saving the video stores the choice
(`videos.thumbnail_choice`) and renders YouTube's thumbnail sizes from it.
Thumbnails are served at `/vi/<videoId>/<name>.jpg` with an ETag, so a new
choice shows up on the next page load. Videos processed before stills
existed get them the first time their details are opened in Studio.

## Channel picture and banner

Studio's Customization > Profile uploads the picture and banner to
`/channel_image_upload/profile` and `/channel_image_upload/banner` (same
resumable protocol; 4 MB and 6 MB). Publishing the page saves them to
`MEDIA_DIR/channels/<channelId>/`; uploads never published are dropped after
a day. They are served at `/ggpht/<channelId>/avatar` and
`/ggpht/<channelId>/banner` (and `avatar-default`, the letter picture), with
ETags so a change shows everywhere at once.

## Dark theme

The main client follows the Appearance setting (Light, Dark or device),
resolved on the server before the page paints. A dark page links the
stylesheet's dark compile, as YouTube's server does. YouTube only serves the
dark compile of its current build, so the pinned build's is derived from a
current light/dark pair and archived beside the light sheet
(`pin/client.json` records the pair and the hash):

```sh
bun scripts/derive-dark-css.ts '<kevlar_base css url, PREF f6=80000>' '<same build, PREF f6=400>'
```

Run it again after re-pinning the client.

## Checking an instance

```sh
bunx tsc --noEmit -p .              # types
bun scripts/check-patches.ts        # client patches still match the pinned builds
bun scripts/e2e/upload.ts           # upload through Studio: remux, playable < 30 s, ladder, playback
bun scripts/e2e/studio-thumbnail.ts # pick a still, upload a custom thumbnail
bun scripts/e2e/studio-customization.ts  # name, handle, links, picture and banner
bun scripts/e2e/gifs.ts             # GIF comments (needs KLIPY_API_KEY)
```

The end-to-end scripts drive the official clients in Chromium against the
running server, sign in as the seeded `bob`, and put back what they change.
