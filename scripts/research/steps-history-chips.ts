// signed-in History: each filter chip in turn (browse reads only)
export default async (page: any, out: string) => {
	for (const [i, chip] of ["Videos", "Shorts", "Music", "All"].entries()) {
		try {
			await page.locator("chip-bar-view-model chip-view-model, yt-chip-cloud-chip-renderer").filter({ hasText: new RegExp(`^\\s*${chip}\\s*$`) }).first().click({ timeout: 8000 });
			await page.waitForTimeout(4000);
			await page.screenshot({ path: `${out}/0${i + 2}-${chip.toLowerCase()}.png` });
		} catch (e) {
			console.log(`no ${chip} chip`);
		}
	}
};
