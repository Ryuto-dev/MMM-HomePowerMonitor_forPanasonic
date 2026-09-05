/*
 * Dev helper (not part of the module): renders demo/preview-fullscreen.html
 * at a given resolution and saves a PNG, so the kiosk layout can be checked
 * for a real Full-HD monitor.
 *
 *   node demo/shoot.mjs [url] [outDir]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const url = process.argv[2] || "http://localhost:8099/demo/preview-fullscreen.html";
const outDir = process.argv[3] || "/tmp/shots";
mkdirSync(outDir, { recursive: true });

const sizes = [
	{ name: "fullhd", width: 1920, height: 1080 },
	{ name: "hd", width: 1280, height: 720 },
	{ name: "ultrawide", width: 2560, height: 1080 },
	{ name: "portrait", width: 1080, height: 1920 }
];

const browser = await chromium.launch({ args: ["--force-device-scale-factor=1"] });

for (const s of sizes) {
	const page = await browser.newPage({ viewport: { width: s.width, height: s.height } });
	await page.goto(url, { waitUntil: "networkidle" });
	await page.waitForSelector(".mmm-hpm--fullscreen", { timeout: 15000 });
	await page.waitForTimeout(1200);

	for (const mode of ["buying", "selling"]) {
		if (mode === "selling") {
			await page.click("#btn-toggle");
			await page.waitForTimeout(600);
		}
		await page.screenshot({ path: `${outDir}/${s.name}-${mode}.png` });
	}

	// Report any element overflowing the viewport (clipping check).
	const overflow = await page.evaluate(() => {
		const bad = [];
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		document.querySelectorAll(".mmm-hpm--fullscreen *").forEach((el) => {
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) return;
			if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) {
				bad.push(`${el.className} l=${r.left.toFixed(0)} t=${r.top.toFixed(0)} r=${r.right.toFixed(0)} b=${r.bottom.toFixed(0)}`);
			}
		});
		const scroller = document.querySelector(".mmm-hpm--fullscreen");
		return {
			bad: bad.slice(0, 12),
			scrollOverflow: scroller
				? { sw: scroller.scrollWidth, cw: scroller.clientWidth, sh: scroller.scrollHeight, ch: scroller.clientHeight }
				: null
		};
	});
	console.log(`\n== ${s.name} ${s.width}x${s.height} ==`);
	console.log(JSON.stringify(overflow, null, 2));

	await page.close();
}

await browser.close();
console.log(`\nSaved to ${outDir}`);
