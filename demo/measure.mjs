/*
 * Dev helper (not part of the module): reports the measured geometry of the
 * fullscreen kiosk layout, so the big readouts / bars / gauge can be tuned to
 * actually use the space available on a Full-HD panel.
 *
 *   node demo/measure.mjs [url] [width] [height]
 */
import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:8099/demo/preview-fullscreen.html";
const width = Number(process.argv[3] || 1920);
const height = Number(process.argv[4] || 1080);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height } });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".mmm-hpm--fullscreen");
await page.waitForTimeout(800);

const report = await page.evaluate(() => {
	const px = (n) => Math.round(n * 10) / 10;
	const box = (sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { w: px(r.width), h: px(r.height) };
	};
	const fs = (sel) => {
		const el = document.querySelector(sel);
		return el ? px(parseFloat(getComputedStyle(el).fontSize)) : null;
	};

	const cards = [...document.querySelectorAll(".mmm-hpm__fs-band .mmm-hpm__fs-card")].map((card) => {
		const value = card.querySelector(".mmm-hpm__fs-value");
		const unit = card.querySelector(".mmm-hpm__fs-unit");
		const readout = card.querySelector(".mmm-hpm__fs-readout");
		const cr = card.getBoundingClientRect();
		const vr = value.getBoundingClientRect();
		const ur = unit.getBoundingClientRect();
		const rr = readout.getBoundingClientRect();
		const cs = getComputedStyle(card);
		const inner = cr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
		const gap = parseFloat(getComputedStyle(readout).columnGap) || 0;
		const used = vr.width + ur.width + gap;
		const f = parseFloat(getComputedStyle(value).fontSize);
		return {
			text: value.textContent,
			fit: card.style.getPropertyValue("--hpm-fit"),
			cardW: px(cr.width),
			innerW: px(inner),
			valueFont: px(f),
			valueW: px(vr.width),
			valueH: px(vr.height),
			readoutH: px(rr.height),
			// em-advance actually consumed by value+gap+unit at this font size
			realEm: px(used / f),
			usedW: px(used),
			slackW: px(inner - used),
			slackPctW: px(((inner - used) / inner) * 100),
			slackPctH: px(((rr.height - vr.height) / rr.height) * 100)
		};
	});

	const dailyBody = document.querySelector(".mmm-hpm__fs-daily-body");
	const bars = document.querySelector(".mmm-hpm__fs-bars");
	const barRows = [...document.querySelectorAll(".mmm-hpm__fs-bar-row")];
	const tiles = [...document.querySelectorAll(".mmm-hpm__fs-money-tile")].map((t) => {
		const r = t.getBoundingClientRect();
		const v = t.querySelector(".mmm-hpm__fs-money-value").getBoundingClientRect();
		return { w: px(r.width), h: px(r.height), valueW: px(v.width) };
	});

	return {
		viewport: { w: innerWidth, h: innerHeight },
		rows: {
			header: box(".mmm-hpm__fs-header"),
			main: box(".mmm-hpm__fs-main"),
			lower: box(".mmm-hpm__fs-lower"),
			footer: box(".mmm-hpm__fs-footer")
		},
		graphs: {
			connector: box(".mmm-hpm__fs-connector"),
			meter: box(".mmm-hpm__fs-band .mmm-hpm__fs-meter"),
			barTrack: box(".mmm-hpm__fs-bar-track"),
			gauge: box(".mmm-hpm__fs-gauge")
		},
		fonts: {
			title: fs(".mmm-hpm__fs-title"),
			clock: fs(".mmm-hpm__fs-clock"),
			cardLabel: fs(".mmm-hpm__fs-card-label"),
			sectionTitle: fs(".mmm-hpm__fs-section-title"),
			barLabel: fs(".mmm-hpm__fs-bar-label"),
			barValue: fs(".mmm-hpm__fs-bar-value"),
			moneyLabel: fs(".mmm-hpm__fs-money-label"),
			moneyValue: fs(".mmm-hpm__fs-money-value"),
			gaugePct: fs(".mmm-hpm__fs-gauge-pct"),
			totalValue: fs(".mmm-hpm__fs-total-item b"),
			meta: fs(".mmm-hpm--fullscreen .mmm-hpm__meta")
		},
		daily: {
			panel: box(".mmm-hpm__fs-daily"),
			body: dailyBody ? box(".mmm-hpm__fs-daily-body") : null,
			barsH: bars ? px(bars.getBoundingClientRect().height) : null,
			barsUsedH: barRows.reduce((a, r) => a + r.getBoundingClientRect().height, 0),
			barRowH: barRows[0] ? px(barRows[0].getBoundingClientRect().height) : null,
			tiles
		},
		cards
	};
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
