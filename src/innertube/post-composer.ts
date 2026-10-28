// Writing posts: the composer on the owner's Posts tab (backstagePostDialogRenderer
// in the item section's commentsHeaderRenderer.createRenderer, opened by itself
// for the Create menu's "Create post", ?show_create_dialog=1) and the edit
// dialog of a post's Edit menu item, answered by backstage/create_post and
// backstage/update_post. The composer's images and image poll pictures are
// sent to /backstage_image_upload first (the Scotty protocol Studio's image
// uploads use, scotty.ts), which answers each with the encryptedBlobId the
// create request then names.
//
// The composer can't be captured (the research account isn't eligible to
// post), so its data follows the client's own components: the fields
// ytd-backstage-post-dialog-renderer, ytd-commentbox and their attachment
// editors read, and the requests they build. The wording is YouTube Help's
// ("Create a post"): Post, Schedule post, Ask your community..., Add option,
// Answer, Add answer.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Viewer } from "../client/page";
import { MEDIA_DIR, PUBLIC_ORIGIN } from "../config";
import { getChannel, getVideo } from "../data";
import { sql } from "../db";
import { decodeToken, encodeToken, isVideoId, newPostId, randomId } from "../ids";
import { imageSize } from "../media/image-size";
import { rateLimit } from "../ratelimit";
import { imageTransfer } from "../studio/scotty";
import { type Attachment, getPost, isScheduled, postRenderer, postThread, scheduledPostsPath, scheduledText } from "./posts";
import { type Channel, type Video, avatarThumbnails, responseContext, runs, serviceEndpoint } from "./r";
import { ApiError, route } from "./router";
import { tabParams } from "./channel";
import { withScheduledPosts } from "./proto";
import { videoRendererVars } from "./search";
import { make } from "./tpl";

export const POST_TEXT_LIMIT = 10_000;
const IMAGE_LIMIT_MB = 16;
const MAX_IMAGES = 10;
const POLL = { min: 2, max: 5, chars: 65 };
const IMAGE_POLL = { min: 2, max: 4, chars: 36 };
const QUIZ = { min: 2, max: 4, chars: 80, imageChars: 30, explanation: 500 };
const POSTS_PER_DAY = 50;
const DAY = 86_400_000;

const PENDING = join(MEDIA_DIR, "posts", "pending");
export const postMediaDir = (postId: string) => join(MEDIA_DIR, "posts", postId);
const UPLOAD_PATH = "/backstage_image_upload";
// the Posts tab params the Create menu's "Create post" link carries (73 asks for the composer)
export const CREATE_POST_PARAMS = "EgVwb3N0c8oEBAoCCAHyBgkKB0oAogECCAE%3D";

// ---- the composer's data ----

type ButtonOpts = { style?: string; size?: string; icon?: string; tooltip?: string; disabled?: boolean };
function button(text: string, opts: ButtonOpts, action: Record<string, unknown> = {}) {
	return {
		buttonRenderer: {
			style: opts.style ?? "STYLE_DEFAULT",
			size: opts.size ?? "SIZE_DEFAULT",
			isDisabled: !!opts.disabled,
			...(text ? { text: runs(text) } : {}),
			...(opts.icon ? { icon: { iconType: opts.icon } } : {}),
			...(opts.tooltip ? { tooltip: opts.tooltip } : {}),
			accessibilityData: { accessibilityData: { label: opts.tooltip ?? text } },
			...action,
		},
	};
}
// a button whose tap runs a client action the dialog handles (yt-create-poll-action and the like)
const clientAction = (action: Record<string, unknown>) => ({ serviceEndpoint: { commandMetadata: { webCommandMetadata: { sendPost: true } }, signalServiceEndpoint: { signal: "CLIENT_SIGNAL", actions: [action] } } });

function uploadEndpoint(c: Channel) {
	return {
		backstageImageUploadEndpoint: {
			uploadUrl: `${PUBLIC_ORIGIN}${UPLOAD_PATH}`,
			channelId: c.id,
			imageValidationInfo: { maxFileSizeMb: IMAGE_LIMIT_MB, allowedMaxAspectRatio: 4 },
			imageEditor: {
				backstageMultiImageSelectRenderer: {
					icon: { iconType: "IMAGE_ADD" },
					dragLabel: runs("Drag up to 10 images or GIFs"),
					selectButton: runs("Select from computer"),
					aspectRatioRequirement: runs("We recommend images with a 1:1 ratio"),
					licenseText: runs("Images must be JPG, PNG, GIF or WEBP, up to 16 MB."),
					cancelButton: button("", { style: "STYLE_DEFAULT", icon: "CLOSE", tooltip: "Remove images" }),
					addImageButton: button("Add image", { style: "STYLE_SUGGESTIVE", size: "SIZE_SMALL", icon: "ADD" }),
					imagePreviewSelectMetadata: previewMetadata(),
					invalidError: runs("This image couldn't be added. Try another one."),
					invalidAspectRatioError: runs("This image's aspect ratio isn't supported."),
					multiFileError: runs("Some images couldn't be added."),
					fileSizeError: runs("Images can be up to 16 MB."),
					multiImageExceedMaxImageCountError: runs("You can add up to 10 images."),
					uploadFailureError: runs("Your images couldn't be uploaded. Try again."),
				},
			},
		},
	};
}

function previewMetadata() {
	return {
		backstageImagePreviewSelectMetadataRenderer: {
			repositionButton: button("Reposition", { style: "STYLE_SUGGESTIVE", size: "SIZE_SMALL" }),
			deleteButton: button("", { icon: "DELETE", tooltip: "Delete" }),
			saveButton: button("Save", { style: "STYLE_PRIMARY", size: "SIZE_SMALL" }),
			cancelButton: button("Cancel", { style: "STYLE_TEXT", size: "SIZE_SMALL" }),
		},
	};
}

const pollEditor = (limits: { min: number; max: number; chars: number }, placeholder: string, addText: string) => ({
	minPollOptions: limits.min,
	maxPollOptions: limits.max,
	minPollOptionChars: 1,
	maxPollOptionChars: limits.chars,
	optionPlaceholderText: runs(placeholder),
	pollOptionData: { removeOptionAltText: runs("Remove option") },
	addOptionButton: button(addText, { style: "STYLE_SUGGESTIVE", size: "SIZE_SMALL", icon: "ADD" }),
});

// ---- scheduling ----

// how far ahead a post can be scheduled (the date picker's calendar runs two years)
const SCHEDULE_DAYS = 730;
// the time zones the schedule panel offers after the viewer's own, each
// with its current offset
const ZONES = [
	"Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Halifax", "America/Sao_Paulo",
	"Atlantic/Azores", "Europe/London", "Europe/Paris", "Europe/Athens", "Africa/Johannesburg", "Europe/Moscow", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata",
	"Asia/Dhaka", "Asia/Bangkok", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];
function zoneOffsetSec(zone: string, at: Date): number {
	const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
	const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part);
	return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60) : 0;
}
function timezoneOptions() {
	const now = new Date();
	return ZONES.map((name) => {
		const sec = zoneOffsetSec(name, now);
		const abs = Math.abs(sec);
		const offset = `GMT${sec < 0 ? "-" : "+"}${String(Math.floor(abs / 3600)).padStart(2, "0")}:${String((abs % 3600) / 60).padStart(2, "0")}`;
		return { name, localizedName: name.split("/").pop()!.replace(/_/g, " "), localizedUtcOffset: offset, utcOffsetSec: String(sec) };
	}).sort((a, b) => Number(a.utcOffsetSec) - Number(b.utcOffsetSec));
}
// the date, time and time zone panel; in the edit dialog it starts at the post's time
const dateTimePicker = (at?: Date) => ({
	dateTimePickerRenderer: {
		header: runs("Schedule post"),
		...(at ? { defaultTimeSec: String(Math.floor(at.getTime() / 1000)) } : {}),
		timezoneOptions: timezoneOptions(),
		...(at ? {} : { dismissButton: button("", { icon: "CLOSE", tooltip: "Cancel scheduling" }) }),
	},
});
// the menu by the Post button: "Schedule post" opens the panel and makes the button Schedule
const postOptionsMenu = () => ({
	menuRenderer: {
		items: [
			{
				menuServiceItemRenderer: {
					text: runs("Schedule post"),
					icon: { iconType: "SCHEDULE" },
					serviceEndpoint: clientAction({ showSchedulingPanelCommand: { scheduleButton: button("Schedule", { style: "STYLE_PRIMARY" }), dateTimePicker: dateTimePicker() } }).serviceEndpoint,
				},
			},
		],
		accessibility: { accessibilityData: { label: "More options" } },
	},
});

// a requested publish time: a string is the message the composer shows
function scheduleTime(v: unknown): Date | string | undefined {
	if (v === undefined || v === null || v === "") return undefined;
	const sec = Number(v);
	if (!Number.isFinite(sec)) return "Choose a date and time to schedule your post.";
	if (sec * 1000 <= Date.now() + 60_000) return "Choose a time in the future.";
	if (sec * 1000 > Date.now() + SCHEDULE_DAYS * 86_400_000) return "Posts can be scheduled up to 2 years ahead.";
	return new Date(sec * 1000);
}
const scheduledToast = (c: Channel, at: Date) => ({
	openPopupAction: {
		popupType: "TOAST",
		popup: {
			notificationActionRenderer: {
				responseText: runs(`Post ${scheduledText(at).replace(/^S/, "s")}`),
				actionButton: button("View", { style: "STYLE_BLUE_TEXT" }, { navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: scheduledPostsPath(c), webPageType: "WEB_PAGE_TYPE_CHANNEL", rootVe: 3611, apiUrl: "/youtubei/v1/browse" } }, browseEndpoint: { browseId: c.id, params: withScheduledPosts(tabParams("posts")), canonicalBaseUrl: `/@${c.handle}` } } }),
			},
		},
	},
});

// the create dialog for the viewer's own channel
export function composer(c: Channel, viewer: NonNullable<Viewer>) {
	const avatar = avatarThumbnails(c.id, [40, 88]);
	const params = encodeToken({ k: "cpost", u: viewer.userId, ch: c.id });
	const placeholder = runs("Share a sneak peek of your next video");
	return {
		backstagePostDialogRenderer: {
			purpose: "BACKSTAGE_POST_DIALOG_PURPOSE_CREATE",
			authorThumbnail: avatar,
			authorText: runs(c.title),
			visibilityLabel: runs("Visibility: Public"),
			placeholderText: placeholder,
			imagePostPlaceholderText: placeholder,
			pollPostPlaceholderText: runs("Ask your community..."),
			quizPostPlaceholderText: runs("Ask your community..."),
			postButton: button("Post", { style: "STYLE_PRIMARY" }, { serviceEndpoint: serviceEndpoint("/youtubei/v1/backstage/create_post", { createBackstagePostEndpoint: { createBackstagePostParams: params } }) }),
			cancelButton: button("Cancel", { style: "STYLE_TEXT" }),
			imageButton: button("", { icon: "LIBRARY_IMAGE", tooltip: "Image" }, { navigationEndpoint: uploadEndpoint(c) }),
			imagePollButton: button("", { icon: "IMAGE_LIST", tooltip: "Image poll" }, clientAction({ createImagePollCommand: {} })),
			pollButton: button("", { icon: "POLL", tooltip: "Text poll" }, clientAction({ createPollAction: {} })),
			quizButton: button("", { icon: "QUIZ", tooltip: "Quiz" }, clientAction({ createQuizCommand: {} })),
			// opens the picker (ytcfg ONE_PICK_URL, picker.ts), then asks for the chosen video's preview
			videoLinkButton: button(
				"",
				{ icon: "VIDEO_LINK", tooltip: "Video" },
				clientAction({
					addVideoLinkAction: {
						title: runs("Select a video"),
						onePickHostId: "youtube",
						onVideoSelectCommand: serviceEndpoint("/youtubei/v1/backstage/get_post_video_preview", { getPostVideoPreviewEndpoint: {} }),
						hideYourYoutubeVideos: false,
					},
				}),
			),
			pollEditorInfo: pollEditor(POLL, "Add option", "Add another option"),
			imagePollEditorRenderer: {
				imagePollEditorRenderer: {
					cellTemplate: { onEmptyCellTap: uploadEndpoint(c) },
					invalidFileSizeError: runs("Images can be up to 16 MB."),
					invalidAspectRatioError: runs("This image's aspect ratio isn't supported."),
					invalidFileTypeError: runs("Use a JPG, PNG, GIF or WEBP image."),
					addOptionButtonText: runs("Add option"),
					repositionImagesButtonLabel: runs("Reposition images"),
					imagePreviewSelectMetadata: previewMetadata(),
				},
			},
			imagePollEditorInfo: { ...pollEditor(IMAGE_POLL, "Option", "Add option"), optionDefaultText: runs("Option") },
			quizEditorInfo: {
				minQuizOptions: QUIZ.min,
				maxQuizOptions: QUIZ.max,
				minQuizOptionChars: 1,
				maxQuizOptionChars: QUIZ.chars,
				maxQuizExplanationChars: QUIZ.explanation,
				optionPlaceholderText: runs("Answer"),
				explanationPlaceholderText: runs("Explain why the answer is correct (optional)"),
				addOptionButton: button("Add answer", { style: "STYLE_SUGGESTIVE", size: "SIZE_SMALL", icon: "ADD" }),
				markAnswerButton: button("", { tooltip: "Mark as correct answer" }),
				removeOptionButtonA11yText: { accessibilityData: { label: "Remove answer" } },
			},
			attachmentDismissButton: button("", { icon: "CLOSE", tooltip: "Remove" }),
			postOptionsMenu: postOptionsMenu(),
			errorMessage: runs("Your post couldn't be published. Try again."),
			charLimit: POST_TEXT_LIMIT,
		},
	};
}

// the edit dialog of a post's Edit menu item: the text only (YouTube keeps a
// post's attachment as it is; polls and quizzes show their text read-only)
export function editDialog(c: Channel, viewer: NonNullable<Viewer>, post: { id: string; text: string; published_at: Date }, attachment: unknown) {
	return {
		backstagePostDialogRenderer: {
			purpose: "BACKSTAGE_POST_DIALOG_PURPOSE_EDIT",
			authorThumbnail: avatarThumbnails(c.id, [40, 88]),
			authorText: runs(c.title),
			editableText: runs(post.text),
			placeholderText: runs("Share a sneak peek of your next video"),
			...(attachment ? { backstageAttachment: attachment } : {}),
			// a scheduled post's time can still change
			...(isScheduled(post) ? { schedulingDateTimePicker: dateTimePicker(new Date(post.published_at)) } : {}),
			submitButton: button("Save", { style: "STYLE_PRIMARY" }, { serviceEndpoint: serviceEndpoint("/youtubei/v1/backstage/update_post", { updateBackstagePostEndpoint: { updateBackstagePostParams: encodeToken({ k: "upost", u: viewer.userId, po: post.id }) } }) }),
			cancelButton: button("Cancel", { style: "STYLE_TEXT" }),
			errorMessage: runs("Your post couldn't be saved. Try again."),
			charLimit: POST_TEXT_LIMIT,
		},
	};
}

// ---- image uploads ----

type Blob = { s: 9; u: string; f: string; w: number; h: number };

export async function postImageUploadRoute(req: Request, url: URL, viewer: Viewer): Promise<Response | undefined> {
	if (url.pathname !== UPLOAD_PATH) return undefined;
	return imageTransfer(req, url, viewer, {
		purpose: "post",
		origin: PUBLIC_ORIGIN,
		limit: IMAGE_LIMIT_MB * 1024 ** 2,
		finish: async (bytes, ext) => {
			if (!viewer) return "Sign in to upload.";
			if (ext === "bmp") return "Use a JPG, PNG, GIF or WEBP image.";
			const size = imageSize(bytes);
			if (!size?.width || !size.height) return "This image couldn't be read.";
			mkdirSync(PENDING, { recursive: true });
			// images no post claimed are dropped after a day
			for (const f of readdirSync(PENDING)) if (Date.now() - statSync(join(PENDING, f)).mtimeMs > DAY) rmSync(join(PENDING, f), { force: true });
			const file = `${randomId(16)}.${ext}`;
			await Bun.write(join(PENDING, file), bytes);
			return { encryptedBlobId: encodeToken({ s: 9, u: viewer.userId, f: file, w: size.width, h: size.height } satisfies Blob) };
		},
	});
}

// an uploaded image, if it is this viewer's and still waiting
function pendingImage(blobId: unknown, viewer: NonNullable<Viewer>): Blob | undefined {
	const t = decodeToken<Blob>(blobId);
	if (t?.s !== 9 || t.u !== viewer.userId || !/^[\w-]{16}\.(jpg|png|gif|webp)$/.test(String(t.f))) return undefined;
	return existsSync(join(PENDING, t.f)) ? t : undefined;
}

// ---- creating and editing ----

const failure = (viewer: Viewer, message: string) => ({ responseContext: responseContext(viewer), actions: [{ showErrorAction: { errorMessage: { messageRenderer: { text: runs(message) } } } }] });
const str = (v: unknown) => (typeof v === "string" ? v : "");

// what the create request attaches, checked against the composer's limits;
// a string is the message the composer shows instead
async function readAttachment(body: any, viewer: NonNullable<Viewer>): Promise<{ attachment: Attachment | null; images: Blob[] } | string> {
	if (body.videoAttachment) {
		const id = str(body.videoAttachment.videoId);
		const v = isVideoId(id) ? await getVideo(id, viewer) : undefined;
		if (!v || !v.playable || v.visibility === "private") return "This video isn't available.";
		return { attachment: { video: id }, images: [] };
	}
	if (body.pollAttachment) {
		const choices = (Array.isArray(body.pollAttachment.choices) ? body.pollAttachment.choices : []).map((c: unknown) => str(c).trim());
		if (choices.length < POLL.min || choices.length > POLL.max || choices.some((c: string) => !c || [...c].length > POLL.chars)) return "Add 2 to 5 options of up to 65 characters.";
		return { attachment: { poll: { choices } }, images: [] };
	}
	if (body.pollAttachmentData) {
		const options = Array.isArray(body.pollAttachmentData.options) ? body.pollAttachmentData.options : [];
		if (options.length < IMAGE_POLL.min || options.length > IMAGE_POLL.max) return "Add 2 to 4 options, each with an image.";
		const images: Blob[] = [];
		const choices = [];
		for (const o of options) {
			const img = pendingImage(o?.image?.encryptedBlobId, viewer);
			const text = str(o?.text).trim();
			if (!img || [...text].length > IMAGE_POLL.chars) return "Each option needs an image and up to 36 characters.";
			images.push(img);
			choices.push({ text, file: img.f, width: img.w, height: img.h });
		}
		return { attachment: { imagePoll: { choices } }, images };
	}
	if (body.quizAttachmentData) {
		const options = Array.isArray(body.quizAttachmentData.options) ? body.quizAttachmentData.options : [];
		const choices = options.map((o: any) => ({ text: str(o?.pollOption?.text).trim(), correct: o?.isCorrect === true, explanation: str(o?.pollOption?.explanation).trim() }));
		if (choices.length < QUIZ.min || choices.length > QUIZ.max || choices.some((c: { text: string }) => !c.text || [...c.text].length > QUIZ.chars)) return "Add 2 to 4 answers of up to 80 characters.";
		if (choices.filter((c: { correct: boolean }) => c.correct).length !== 1) return "Mark one answer as correct.";
		if (choices.some((c: { explanation: string }) => [...c.explanation].length > QUIZ.explanation)) return "Explanations can be up to 500 characters.";
		return { attachment: { quiz: { choices: choices.map((c: { text: string; correct: boolean; explanation: string }) => ({ text: c.text, correct: c.correct, ...(c.correct && c.explanation ? { explanation: c.explanation } : {}) })) } }, images: [] };
	}
	const blobs = body.imagesAttachment ? (Array.isArray(body.imagesAttachment.imagesData) ? body.imagesAttachment.imagesData.map((d: any) => d?.encryptedBlobId) : []) : body.imageAttachment ? [body.imageAttachment.encryptedBlobId] : [];
	if (blobs.length) {
		if (blobs.length > MAX_IMAGES) return "You can add up to 10 images.";
		const images = blobs.map((b: unknown) => pendingImage(b, viewer));
		if (images.some((i: Blob | undefined) => !i)) return "Your images couldn't be uploaded. Try again.";
		return { attachment: { images: (images as Blob[]).map((i) => ({ file: i.f, width: i.w, height: i.h })) }, images: images as Blob[] };
	}
	return { attachment: null, images: [] };
}

// the chosen video as the composer shows it before posting
route("backstage/get_post_video_preview", async ({ body, viewer }) => {
	if (!viewer) throw new ApiError(401, "Sign in to post.");
	const id = str(body.videoId);
	const v = isVideoId(id) ? await getVideo(id, viewer) : undefined;
	if (!v || !v.playable || v.visibility === "private") throw new ApiError(404, "This video isn't available.");
	return {
		responseContext: responseContext(viewer),
		actions: [{ addVideoPreviewAction: { videoPreview: make("item/post_video", videoRendererVars(v as Video, viewer)), cancelButton: button("", { icon: "CLOSE", tooltip: "Remove video" }) } }],
	};
});

route(
	"backstage/create_post",
	async ({ body, viewer }) => {
		const t = decodeToken<{ k: string; u: string; ch: string }>(body.createBackstagePostParams);
		if (!viewer || t?.k !== "cpost" || t.u !== viewer.userId || t.ch !== viewer.channelId) throw new ApiError(400, "Invalid post parameters");
		const c = await getChannel({ id: viewer.channelId });
		if (!c) throw new ApiError(404, "Not found");
		const text = str(body.commentText).trim();
		if ([...text].length > POST_TEXT_LIMIT) return failure(viewer, "Your post is too long.");
		const at = scheduleTime(body.scheduledPublishTimeSec);
		if (typeof at === "string") return failure(viewer, at);
		const read = await readAttachment(body, viewer);
		if (typeof read === "string") return failure(viewer, read);
		if (!text && !read.attachment) return failure(viewer, "Write something or add an attachment.");
		if (!(await rateLimit(`post:${viewer.userId}`, POSTS_PER_DAY, 86_400))) return failure(viewer, "You've reached today's post limit. Try again in 24 hours.");
		const id = newPostId();
		if (read.images.length) {
			mkdirSync(postMediaDir(id), { recursive: true });
			for (const img of read.images) renameSync(join(PENDING, img.f), join(postMediaDir(id), img.f));
		}
		await sql`insert into posts (id, channel_id, text, attachment, published_at) values (${id}, ${c.id}, ${text}, ${read.attachment ? JSON.stringify(read.attachment) : null}::text::jsonb, ${at ?? new Date()})`;
		// a scheduled post waits in the Scheduled section; the composer just clears
		if (at) return { responseContext: responseContext(viewer), actions: [scheduledToast(c, at)] };
		const post = await getPost(id, viewer);
		const thread = await postThread(post!, c, viewer);
		return { responseContext: responseContext(viewer), actions: [{ addBackstagePostAction: { renderer: thread } }] };
	},
	{ mutation: true },
);

route(
	"backstage/update_post",
	async ({ body, viewer }) => {
		const t = decodeToken<{ k: string; u: string; po: string }>(body.updateBackstagePostParams);
		if (!viewer || t?.k !== "upost" || t.u !== viewer.userId) throw new ApiError(400, "Invalid post parameters");
		const post = await getPost(t.po, viewer);
		if (!post || post.channel_id !== viewer.channelId) throw new ApiError(404, "This post isn't available anymore.");
		const c = await getChannel({ id: viewer.channelId });
		if (!c) throw new ApiError(404, "Not found");
		if (body.commentText !== undefined) {
			const text = str(body.commentText).trim();
			if ([...text].length > POST_TEXT_LIMIT) return failure(viewer, "Your post is too long.");
			if (!text && !post.attachment) return failure(viewer, "Write something or add an attachment.");
			if (text !== post.text) await sql`update posts set text = ${text}, edited_at = now() where id = ${post.id}`;
		}
		if (body.scheduledPublishTimeSec !== undefined) {
			if (!isScheduled(post)) return failure(viewer, "This post is already published.");
			const at = scheduleTime(body.scheduledPublishTimeSec);
			if (typeof at === "string") return failure(viewer, at);
			if (at) await sql`update posts set published_at = ${at} where id = ${post.id} and published_at > now()`;
		}
		const updated = await getPost(post.id, viewer);
		return { responseContext: responseContext(viewer), actions: [{ replaceBackstagePostAction: { itemId: post.id, renderer: await postRenderer(updated!, c, viewer) } }] };
	},
	{ mutation: true },
);
