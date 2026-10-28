// search results: the Shorts, Unwatched and Live chips in turn (search reads only)
export default async (page: any, out: string) => {
	for (const [i, chip] of ["Shorts", "Unwatched", "Live", "All"].entries()) {
		try {
			await page.locator("yt-chip-cloud-chip-renderer").filter({ hasText: new RegExp(`^\\s*${chip}\\s*$`) }).first().click({ timeout: 8000 });
			await page.waitForTimeout(4000);
			await page.screenshot({ path: `${out}/0${i + 2}-${chip.toLowerCase()}.png` });
		} catch (e) {
			console.log(`no ${chip} chip`);
		}
	}
};
