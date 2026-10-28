// YouTube's video categories: the ids Studio's Category field saves
// (metadata_update category.newCategoryId), its enum names, and the names
// the watch page's microformat carries. From Studio's own tables (Cyb, TSe).
export const CATEGORIES: Record<number, [string, string]> = {
	1: ["CREATOR_VIDEO_CATEGORY_FILM", "Film & Animation"],
	2: ["CREATOR_VIDEO_CATEGORY_AUTOS", "Autos & Vehicles"],
	10: ["CREATOR_VIDEO_CATEGORY_MUSIC", "Music"],
	15: ["CREATOR_VIDEO_CATEGORY_PETS", "Pets & Animals"],
	17: ["CREATOR_VIDEO_CATEGORY_SPORTS", "Sports"],
	19: ["CREATOR_VIDEO_CATEGORY_TRAVEL", "Travel & Events"],
	20: ["CREATOR_VIDEO_CATEGORY_GADGETS", "Gaming"],
	22: ["CREATOR_VIDEO_CATEGORY_PEOPLE", "People & Blogs"],
	23: ["CREATOR_VIDEO_CATEGORY_COMEDY", "Comedy"],
	24: ["CREATOR_VIDEO_CATEGORY_ENTERTAINMENT", "Entertainment"],
	25: ["CREATOR_VIDEO_CATEGORY_NEWS", "News & Politics"],
	26: ["CREATOR_VIDEO_CATEGORY_HOWTO", "Howto & Style"],
	27: ["CREATOR_VIDEO_CATEGORY_EDUCATION", "Education"],
	28: ["CREATOR_VIDEO_CATEGORY_SCIENCE", "Science & Technology"],
	29: ["CREATOR_VIDEO_CATEGORY_GOVERNMENT", "Nonprofits & Activism"],
};
export const DEFAULT_CATEGORY = 22;
export const MUSIC_CATEGORY = 10;
const category = (id: number | null | undefined) => CATEGORIES[id ?? DEFAULT_CATEGORY] ?? CATEGORIES[DEFAULT_CATEGORY];
export const categoryEnum = (id: number | null | undefined) => category(id)[0];
export const categoryName = (id: number | null | undefined) => category(id)[1];
