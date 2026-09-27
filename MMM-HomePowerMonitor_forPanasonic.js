/* global Module, Log, moment */

/*
 * MMM-HomePowerMonitor_forPanasonic
 * A MagicMirror² module that talks directly to a Panasonic energy-monitor
 * power detection unit (e.g. VBPX274) over the local network and renders
 * an animated, modern "energy flow" dashboard (solar -> home -> grid).
 *
 * Author: Ryuto-dev
 * License: MIT
 */

Module.register("MMM-HomePowerMonitor_forPanasonic", {
	// ------------------------------------------------------------------
	// Default configuration. Can be overridden in the user's config.js
	// ------------------------------------------------------------------
	defaults: {
		// --- Connection (required) ---
		ipAddress: "", // e.g. "192.168.1.105"
		deviceId: "", // e.g. "17120385X"
		username: "", // required: HTTP Basic auth user of the device (e.g. "user")
		password: "", // required: HTTP Basic auth password of the device
		port: 80,

		// --- Timing ---
		updateInterval: 5 * 1000, // realtime power, default 5s as requested
		dailyUpdateInterval: 60 * 1000, // today's Wh/yen totals
		totalUpdateInterval: 10 * 60 * 1000, // lifetime totals since install
		requestTimeout: 5 * 1000,
		retryDelay: 10 * 1000, // wait before retrying after a failed request
		animationSpeed: 800, // dom update transition speed (ms)

		// --- Feature toggles ---
		showDaily: true, // show today's kWh / yen summary bar chart
		showLifetimeTotal: true, // show cumulative-since-install footer
		showSelfSufficiencyRing: true, // show the SSR donut in the home node
		showStatusBadge: true, // show "selling/buying" badge
		showLastUpdated: true,

		// --- Fullscreen ("kiosk") layout ---
		// Used automatically when position is fullscreen_above / fullscreen_below.
		fullscreenTitle: "", // header title override (default: translated)
		fullscreenSubtitle: "", // header subtitle override (default: translated)
		showFullscreenClock: true, // big clock in the header
		fullscreenScale: 1, // global size multiplier for every fullscreen text/graph

		// --- Formatting ---
		currencySymbol: "¥",
		currencyLocale: "ja-JP",
		decimalsRealtime: 1,
		decimalsEnergy: 2,
		decimalsCurrency: 1,

		// --- Visuals ---
		colorGeneration: "#ffd166",
		colorSell: "#06d6a0",
		colorBuy: "#ef476f",
		colorConsumption: "#4cc9f0",
		minFlowDurationSec: 0.6, // fastest dot animation (high power)
		maxFlowDurationSec: 4, // slowest dot animation (low/no power)
		flowReferenceWatts: 2000, // power at which animation reaches min duration

		debug: false
	},

	// requiresVersion introduced in 2.1.0
	requiresVersion: "2.1.0",

	// ------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------
	start () {
		Log.info(`Starting module: ${this.name} (${this.identifier})`);

		this.loaded = false;
		this.connected = false;
		this.lastError = null;
		this.lastUpdated = null;

		this.realtime = null; // { igo, isi, ibi, aoc, ssr, status }
		this.daily = null; // { igoWh, isiWh, ismYen, ibiWh, ibmYen, ... }
		this.total = null; // { tgtWh, tstWh, tbtWh, ... }

		this.sendSocketNotification("HPM_INIT", {
			identifier: this.identifier,
			config: this.config
		});
	},

	getStyles () {
		return ["MMM-HomePowerMonitor_forPanasonic.css"];
	},

	getTranslations () {
		return {
			en: "translations/en.json",
			ja: "translations/ja.json"
		};
	},

	// ------------------------------------------------------------------
	// Socket notifications from node_helper.js
	// ------------------------------------------------------------------
	socketNotificationReceived (notification, payload) {
		if (!payload || payload.identifier !== this.identifier) {
			return;
		}

		switch (notification) {
			case "HPM_REALTIME_DATA":
				this.connected = true;
				this.loaded = true;
				this.lastError = null;
				this.lastUpdated = payload.timestamp;
				this.realtime = payload.data;
				this.updateDom(this.config.animationSpeed);
				break;

			case "HPM_DAILY_DATA":
				this.daily = payload.data;
				this.updateDom(this.config.animationSpeed);
				break;

			case "HPM_TOTAL_DATA":
				this.total = payload.data;
				this.updateDom(this.config.animationSpeed);
				break;

			case "HPM_ERROR":
				this.connected = false;
				this.loaded = true;
				this.lastError = payload.message;
				this.updateDom(this.config.animationSpeed);
				break;
		}
	},

	// ------------------------------------------------------------------
	// Rendering
	// ------------------------------------------------------------------
	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "mmm-hpm";
		const positionClass = this._positionClass();
		wrapper.classList.add(positionClass);

		const isFullscreen = positionClass === "mmm-hpm--fullscreen";
		if (isFullscreen) {
			// Global size multiplier so users can fine-tune for their monitor.
			const scale = Number(this.config.fullscreenScale) || 1;
			wrapper.style.setProperty("--hpm-fs-scale", String(scale));
		}

		if (!this.config.ipAddress || !this.config.deviceId) {
			wrapper.classList.add("mmm-hpm--config-error");
			wrapper.innerHTML = `<div class="mmm-hpm__error">${this.translate("CONFIG_MISSING")}</div>`;
			return wrapper;
		}

		if (!this.config.username || !this.config.password) {
			wrapper.classList.add("mmm-hpm--config-error");
			wrapper.innerHTML = `<div class="mmm-hpm__error">${this.translate("AUTH_MISSING")}</div>`;
			return wrapper;
		}

		if (!this.loaded) {
			wrapper.classList.add("mmm-hpm--loading");
			const loading = document.createElement("div");
			loading.className = "mmm-hpm__loading";
			loading.innerHTML = `<div class="mmm-hpm__spinner"></div><span>${this.translate("LOADING")}</span>`;
			wrapper.appendChild(loading);
			return wrapper;
		}

		if (isFullscreen) {
			this._buildFullscreenDom(wrapper);
			return wrapper;
		}

		wrapper.appendChild(this._buildFlowSection());

		if (this.config.showStatusBadge) {
			wrapper.appendChild(this._buildStatusBadge());
		}

		if (this.config.showDaily && this.daily) {
			wrapper.appendChild(this._buildDailySection());
		}

		if (this.config.showLifetimeTotal && this.total) {
			wrapper.appendChild(this._buildTotalSection());
		}

		wrapper.appendChild(this._buildMetaSection());

		return wrapper;
	},

	// ---- helpers ------------------------------------------------------

	_positionClass () {
		const position = this.data.position || "";
		if (position.indexOf("fullscreen") !== -1) {
			return "mmm-hpm--fullscreen";
		}
		if (position.indexOf("bar") !== -1) {
			return "mmm-hpm--bar";
		}
		if (position.indexOf("left") !== -1 || position.indexOf("right") !== -1) {
			return "mmm-hpm--side";
		}
		return "mmm-hpm--center";
	},

	_fmtW (value) {
		const n = Number(value) || 0;
		return n.toLocaleString(this.config.currencyLocale, {
			minimumFractionDigits: this.config.decimalsRealtime,
			maximumFractionDigits: this.config.decimalsRealtime
		});
	},

	_fmtKWh (wh) {
		const n = (Number(wh) || 0) / 1000;
		return n.toLocaleString(this.config.currencyLocale, {
			minimumFractionDigits: this.config.decimalsEnergy,
			maximumFractionDigits: this.config.decimalsEnergy
		});
	},

	_fmtYen (yen) {
		const n = Number(yen) || 0;
		const decimals = typeof this.config.decimalsCurrency === "number" ? this.config.decimalsCurrency : 1;
		const absN = Math.abs(n);
		const formatted = absN.toLocaleString(this.config.currencyLocale, {
			minimumFractionDigits: decimals,
			maximumFractionDigits: decimals
		});
		// Keep the sign in front of the currency symbol ("-¥451.0", not "¥-451.0").
		const sign = n < 0 ? "-" : "";
		return `${sign}${this.config.currencySymbol}${formatted}`;
	},

	_flowDurationSec (watts) {
		const w = Math.max(Math.abs(Number(watts) || 0), 0);
		const ref = Math.max(this.config.flowReferenceWatts, 1);
		const ratio = Math.min(w / ref, 1);
		const { minFlowDurationSec, maxFlowDurationSec } = this.config;
		// higher power => faster (shorter) duration
		return maxFlowDurationSec - (ratio * (maxFlowDurationSec - minFlowDurationSec));
	},

	_buildFlowSection () {
		const rt = this.realtime || { igo: 0, isi: 0, ibi: 0, aoc: 0, ssr: 0, status: "buying" };

		const section = document.createElement("div");
		section.className = "mmm-hpm__flow";

		// --- Solar node ---
		const solarNode = this._buildNode(
			"solar",
			"☀️",
			this.translate("GENERATION"),
			`${this._fmtW(rt.igo)} W`,
			this.config.colorGeneration
		);

		// --- line: solar -> home ---
		const solarLine = this._buildLine("solar-home", rt.igo > 0.5, this._flowDurationSec(rt.igo), false);

		// --- Home node (with SSR ring) ---
		const homeNode = document.createElement("div");
		homeNode.className = "mmm-hpm__node mmm-hpm__node--home";

		if (this.config.showSelfSufficiencyRing) {
			homeNode.appendChild(this._buildSSRRing(rt.ssr));
		} else {
			const icon = document.createElement("div");
			icon.className = "mmm-hpm__icon";
			icon.textContent = "🏠";
			homeNode.appendChild(icon);
		}

		const homeLabel = document.createElement("div");
		homeLabel.className = "mmm-hpm__node-label";
		homeLabel.innerHTML = `<span class="mmm-hpm__node-title">${this.translate("CONSUMPTION")}</span><span class="mmm-hpm__node-value" style="color:${this.config.colorConsumption}">${this._fmtW(rt.aoc)} W</span>`;
		homeNode.appendChild(homeLabel);

		// --- line: home <-> grid ---
		const isSelling = rt.status === "selling";
		const gridPower = isSelling ? rt.isi : rt.ibi;
		const gridLine = this._buildLine("home-grid", gridPower > 0.5, this._flowDurationSec(gridPower), !isSelling);

		// --- Grid node ---
		const gridColor = isSelling ? this.config.colorSell : this.config.colorBuy;
		const gridLabelText = isSelling ? this.translate("SELLING") : this.translate("BUYING");
		const gridValue = isSelling ? rt.isi : rt.ibi;
		const gridNode = this._buildNode("grid", "⚡", gridLabelText, `${this._fmtW(gridValue)} W`, gridColor);

		section.appendChild(solarNode);
		section.appendChild(solarLine);
		section.appendChild(homeNode);
		section.appendChild(gridLine);
		section.appendChild(gridNode);

		return section;
	},

	_buildNode (kind, emoji, label, value, color) {
		const node = document.createElement("div");
		node.className = `mmm-hpm__node mmm-hpm__node--${kind}`;

		const icon = document.createElement("div");
		icon.className = "mmm-hpm__icon";
		icon.style.color = color;
		icon.textContent = emoji;

		const labelWrap = document.createElement("div");
		labelWrap.className = "mmm-hpm__node-label";
		labelWrap.innerHTML = `<span class="mmm-hpm__node-title">${label}</span><span class="mmm-hpm__node-value" style="color:${color}">${value}</span>`;

		node.appendChild(icon);
		node.appendChild(labelWrap);
		return node;
	},

	_buildLine (kind, active, durationSec, reverse) {
		const line = document.createElement("div");
		line.className = `mmm-hpm__line mmm-hpm__line--${kind}`;
		if (active) {
			line.classList.add("mmm-hpm__line--active");
		}
		if (reverse) {
			line.classList.add("mmm-hpm__line--reverse");
		}

		const track = document.createElement("div");
		track.className = "mmm-hpm__line-track";

		const dot = document.createElement("div");
		dot.className = "mmm-hpm__dot";
		dot.style.animationDuration = `${durationSec}s`;

		track.appendChild(dot);
		line.appendChild(track);
		return line;
	},

	_buildSSRRing (ssr) {
		const value = Math.max(0, Number(ssr) || 0);
		const pct = Math.min(value, 100);
		const radius = 34;
		const circumference = 2 * Math.PI * radius;
		const offset = circumference * (1 - pct / 100);
		const over = value > 100 ? " mmm-hpm__ssr-pct--over" : "";

		const wrap = document.createElement("div");
		wrap.className = `mmm-hpm__ssr-ring${value > 100 ? " mmm-hpm__ssr-ring--over" : ""}`;

		wrap.innerHTML = `
			<svg viewBox="0 0 80 80" class="mmm-hpm__ssr-svg">
				<circle cx="40" cy="40" r="${radius}" class="mmm-hpm__ssr-bg"></circle>
				<circle cx="40" cy="40" r="${radius}"
					class="mmm-hpm__ssr-fg"
					stroke-dasharray="${circumference}"
					stroke-dashoffset="${offset}"
					transform="rotate(-90 40 40)"></circle>
			</svg>
			<div class="mmm-hpm__ssr-text">
				<span class="mmm-hpm__ssr-pct${over}">${value.toFixed(0)}%</span>
				<span class="mmm-hpm__ssr-caption">${this.translate("SELF_SUFFICIENCY")}</span>
			</div>
		`;

		return wrap;
	},

	_buildStatusBadge () {
		const rt = this.realtime || { status: "buying" };
		const isSelling = rt.status === "selling";

		const badge = document.createElement("div");
		badge.className = `mmm-hpm__status-badge ${isSelling ? "mmm-hpm__status-badge--sell" : "mmm-hpm__status-badge--buy"}`;
		badge.innerHTML = `<span class="mmm-hpm__status-dot"></span>${isSelling ? this.translate("STATUS_SELLING") : this.translate("STATUS_BUYING")}`;
		return badge;
	},

	_buildDailySection () {
		const d = this.daily;
		const wrap = document.createElement("div");
		wrap.className = "mmm-hpm__daily";

		const title = document.createElement("div");
		title.className = "mmm-hpm__section-title";
		title.textContent = this.translate("TODAY");
		wrap.appendChild(title);

		const bars = document.createElement("div");
		bars.className = "mmm-hpm__bars";

		const maxWh = Math.max(d.igoWh, d.isiWh, d.ibiWh, 1);

		bars.appendChild(this._buildBar(this.translate("GENERATION"), d.igoWh, maxWh, this.config.colorGeneration));
		bars.appendChild(this._buildBar(this.translate("SELL"), d.isiWh, maxWh, this.config.colorSell));
		bars.appendChild(this._buildBar(this.translate("BUY"), d.ibiWh, maxWh, this.config.colorBuy));

		wrap.appendChild(bars);

		const money = document.createElement("div");
		money.className = "mmm-hpm__money";
		const net = (d.ismYen || 0) - (d.ibmYen || 0);
		const netClass = net >= 0 ? "mmm-hpm__money-net--positive" : "mmm-hpm__money-net--negative";
		money.innerHTML = `
			<span class="mmm-hpm__money-item">${this.translate("SELL_AMOUNT")}: ${this._fmtYen(d.ismYen)}</span>
			<span class="mmm-hpm__money-item">${this.translate("BUY_AMOUNT")}: ${this._fmtYen(d.ibmYen)}</span>
			<span class="mmm-hpm__money-item ${netClass}">${this.translate("NET_BALANCE")}: ${this._fmtYen(net)}</span>
		`;
		wrap.appendChild(money);

		return wrap;
	},

	_buildBar (label, wh, maxWh, color) {
		const row = document.createElement("div");
		row.className = "mmm-hpm__bar-row";

		const pct = Math.max(2, Math.min(100, (wh / maxWh) * 100));

		row.innerHTML = `
			<span class="mmm-hpm__bar-label">${label}</span>
			<div class="mmm-hpm__bar-track">
				<div class="mmm-hpm__bar-fill" style="width:${pct}%;background:${color}"></div>
			</div>
			<span class="mmm-hpm__bar-value">${this._fmtKWh(wh)} kWh</span>
		`;

		return row;
	},

	_buildTotalSection () {
		const t = this.total;
		const wrap = document.createElement("div");
		wrap.className = "mmm-hpm__total";

		wrap.innerHTML = `
			<span class="mmm-hpm__total-item">${this.translate("LIFETIME")} ${this.translate("GENERATION")}: ${this._fmtKWh(t.tgtWh)} kWh</span>
			<span class="mmm-hpm__total-item">${this.translate("SELL")}: ${this._fmtKWh(t.tstWh)} kWh</span>
			<span class="mmm-hpm__total-item">${this.translate("BUY")}: ${this._fmtKWh(t.tbtWh)} kWh</span>
		`;

		return wrap;
	},

	// ==================================================================
	// Fullscreen ("kiosk") layout — for fullscreen_above / fullscreen_below
	//
	// Designed for a Full-HD (1920x1080) monitor viewed from a distance,
	// like the energy-visualization panels found in shops/showrooms:
	// very large numbers, thick bars and a big gauge.
	// ==================================================================

	_buildFullscreenDom (wrapper) {
		wrapper.appendChild(this._fsHeader());

		// Row 1: the three big readouts get the *entire* width of the screen —
		// nothing else competes with them, so the numbers can be as large as
		// the design allows (the whole point of a "read it from across the
		// room" kiosk panel).
		const main = document.createElement("div");
		main.className = "mmm-hpm__fs-main";
		main.appendChild(this._fsFlowBand());
		wrapper.appendChild(main);

		// Row 2: today's energy + the self-sufficiency gauge side by side.
		const showGauge = this.config.showSelfSufficiencyRing;
		const showDaily = this.config.showDaily && !!this.daily;

		if (!showGauge && !showDaily) {
			// Nothing below the flow band: the cards would otherwise stretch to
			// the full remaining height while the readout stays width-limited,
			// leaving a lot of dead space above and below each number. The class
			// lets the CSS keep the band in a sensible proportion instead.
			wrapper.classList.add("mmm-hpm--fs-band-only");
		}

		if (showGauge || showDaily) {
			const lower = document.createElement("div");
			lower.className = "mmm-hpm__fs-lower";
			if (!showGauge) {
				lower.classList.add("mmm-hpm__fs-lower--no-gauge");
			}
			if (!showDaily) {
				lower.classList.add("mmm-hpm__fs-lower--no-daily");
			}

			if (showDaily) {
				lower.appendChild(this._fsDaily());
			}
			if (showGauge) {
				lower.appendChild(this._fsGauge());
			}
			wrapper.appendChild(lower);
		}

		wrapper.appendChild(this._fsFooter());
	},

	/** Adaptive big-number formatter: integer W below 1 kW, kW above. */
	_fmtBig (watts) {
		const n = Number(watts) || 0;
		if (Math.abs(n) >= 1000) {
			return {
				value: (n / 1000).toLocaleString(this.config.currencyLocale, {
					minimumFractionDigits: 2,
					maximumFractionDigits: 2
				}),
				unit: "kW"
			};
		}
		return {
			value: Math.round(n).toLocaleString(this.config.currencyLocale),
			unit: "W"
		};
	},

	_fsHeader () {
		const header = document.createElement("div");
		header.className = "mmm-hpm__fs-header";

		const titles = document.createElement("div");
		titles.className = "mmm-hpm__fs-titles";
		const title = this.config.fullscreenTitle || this.translate("DASHBOARD_TITLE");
		const subtitle = this.config.fullscreenSubtitle || this.translate("DASHBOARD_SUBTITLE");
		titles.innerHTML = `
			<div class="mmm-hpm__fs-title">${title}</div>
			<div class="mmm-hpm__fs-subtitle">${subtitle}</div>
		`;
		header.appendChild(titles);

		const right = document.createElement("div");
		right.className = "mmm-hpm__fs-header-right";

		if (this.config.showStatusBadge) {
			right.appendChild(this._buildStatusBadge());
		}

		if (this.config.showFullscreenClock) {
			const clock = document.createElement("div");
			clock.className = "mmm-hpm__fs-clock";
			clock.textContent = this._clockText();
			right.appendChild(clock);
		}

		header.appendChild(right);
		return header;
	},

	_clockText () {
		const now = new Date();
		const hh = String(now.getHours()).padStart(2, "0");
		const mm = String(now.getMinutes()).padStart(2, "0");
		return `${hh}:${mm}`;
	},

	_fsFlowBand () {
		const rt = this.realtime || { igo: 0, isi: 0, ibi: 0, aoc: 0, ssr: 0, status: "buying" };
		const isSelling = rt.status === "selling";
		const gridValue = isSelling ? rt.isi : rt.ibi;
		const gridColor = isSelling ? this.config.colorSell : this.config.colorBuy;

		const band = document.createElement("div");
		band.className = "mmm-hpm__fs-band";

		// Common reference so the three magnitude meters are comparable.
		const scaleMax = Math.max(rt.igo, rt.aoc, gridValue, this.config.flowReferenceWatts, 1);

		band.appendChild(this._fsStatCard({
			kind: "solar",
			icon: "☀️",
			label: this.translate("GENERATION"),
			watts: rt.igo,
			scaleMax,
			color: this.config.colorGeneration
		}));

		band.appendChild(this._fsConnector("solar-home", rt.igo > 0.5, this._flowDurationSec(rt.igo), false));

		band.appendChild(this._fsStatCard({
			kind: "home",
			icon: "🏠",
			label: this.translate("CONSUMPTION"),
			watts: rt.aoc,
			scaleMax,
			color: this.config.colorConsumption
		}));

		band.appendChild(this._fsConnector("home-grid", gridValue > 0.5, this._flowDurationSec(gridValue), !isSelling));

		band.appendChild(this._fsStatCard({
			kind: "grid",
			icon: "⚡",
			label: isSelling ? this.translate("SELLING") : this.translate("BUYING"),
			watts: gridValue,
			scaleMax,
			color: gridColor
		}));

		return band;
	},

	/*
	 * Width the readout is allowed to occupy, expressed as a multiplier of
	 * 1cqw (1% of the card's *content box*). CSS then uses
	 * `min(<design ceiling>, calc(var(--hpm-fit) * 1cqw))`, so a short value
	 * such as "610" is rendered much larger than a long one such as "10.00"
	 * instead of every card being permanently shrunk to the worst case.
	 *
	 * The advances below are *measured* (see demo/measure.mjs) from the bold
	 * condensed faces MagicMirror ships with, in em of the value's font size:
	 *   digit                       0.536em
	 *   "." / "," (narrow glyphs)   0.260em
	 *   unit + its gap: "kW"        0.570em , "W" 0.370em
	 * A per-character average would over-reserve by ~12% on decimal values
	 * ("1.42") and leave the number needlessly small, so each glyph class is
	 * counted separately.
	 */
	_fsFitFactor (valueText, unit) {
		const text = String(valueText);
		let em = 0;
		for (const ch of text) {
			em += (ch === "." || ch === ",") ? 0.26 : 0.536;
		}
		em += unit === "kW" ? 0.57 : 0.37;
		// The card's padding is already outside the cqw basis, so only a small
		// safety margin is needed here.
		const usableCqw = 96;
		return usableCqw / Math.max(em, 0.1);
	},

	_fsStatCard ({ kind, icon, label, watts, scaleMax, color }) {
		const big = this._fmtBig(watts);
		const pct = Math.max(0, Math.min(100, ((Number(watts) || 0) / scaleMax) * 100));

		const card = document.createElement("div");
		card.className = `mmm-hpm__fs-card mmm-hpm__fs-card--${kind}`;
		card.style.setProperty("--hpm-accent", color);
		card.style.setProperty("--hpm-fit", this._fsFitFactor(big.value, big.unit).toFixed(2));

		card.innerHTML = `
			<div class="mmm-hpm__fs-card-head">
				<span class="mmm-hpm__fs-card-icon">${icon}</span>
				<span class="mmm-hpm__fs-card-label">${label}</span>
			</div>
			<div class="mmm-hpm__fs-readout">
				<span class="mmm-hpm__fs-value">${big.value}</span>
				<span class="mmm-hpm__fs-unit">${big.unit}</span>
			</div>
			<div class="mmm-hpm__fs-meter">
				<div class="mmm-hpm__fs-meter-fill" style="width:${pct}%"></div>
			</div>
			<div class="mmm-hpm__fs-card-bar"></div>
		`;
		return card;
	},

	_fsConnector (kind, active, durationSec, reverse) {
		const line = document.createElement("div");
		line.className = `mmm-hpm__fs-connector mmm-hpm__line mmm-hpm__line--${kind}`;
		if (active) {
			line.classList.add("mmm-hpm__line--active");
		}
		if (reverse) {
			line.classList.add("mmm-hpm__line--reverse");
		}

		const track = document.createElement("div");
		track.className = "mmm-hpm__line-track";

		// Several dots for a clearly visible "power stream" at a distance.
		for (let i = 0; i < 3; i++) {
			const dot = document.createElement("div");
			dot.className = "mmm-hpm__dot";
			dot.style.animationDuration = `${durationSec}s`;
			dot.style.animationDelay = `${(durationSec / 3) * i}s`;
			track.appendChild(dot);
		}

		line.appendChild(track);
		return line;
	},

	_fsGauge () {
		const rt = this.realtime || { ssr: 0 };
		const value = Math.max(0, Number(rt.ssr) || 0);
		const pct = Math.min(value, 100);
		const radius = 108;
		const circumference = 2 * Math.PI * radius;
		const offset = circumference * (1 - pct / 100);

		const card = document.createElement("div");
		const isOver = value > 100;
		card.className = `mmm-hpm__fs-card mmm-hpm__fs-card--gauge${isOver ? " mmm-hpm__fs-card--over" : ""}`;
		card.style.setProperty("--hpm-accent", isOver ? this.config.colorGeneration : this.config.colorConsumption);

		card.innerHTML = `
			<div class="mmm-hpm__fs-card-head">
				<span class="mmm-hpm__fs-card-label">${this.translate("SELF_SUFFICIENCY")}</span>
			</div>
			<div class="mmm-hpm__fs-gauge">
				<svg viewBox="0 0 260 260" class="mmm-hpm__fs-gauge-svg">
					<circle cx="130" cy="130" r="${radius}" class="mmm-hpm__fs-gauge-bg"></circle>
					<circle cx="130" cy="130" r="${radius}"
						class="mmm-hpm__fs-gauge-fg"
						stroke-dasharray="${circumference}"
						stroke-dashoffset="${offset}"
						transform="rotate(-90 130 130)"></circle>
				</svg>
				<div class="mmm-hpm__fs-gauge-text">
					<span class="mmm-hpm__fs-gauge-pct${isOver ? " mmm-hpm__fs-gauge-pct--over" : ""}">${value.toFixed(0)}<small>%</small></span>
				</div>
			</div>
			<div class="mmm-hpm__fs-card-bar"></div>
		`;
		return card;
	},

	_fsDaily () {
		const d = this.daily;
		const wrap = document.createElement("div");
		wrap.className = "mmm-hpm__fs-daily";

		const head = document.createElement("div");
		head.className = "mmm-hpm__fs-section-head";
		head.innerHTML = `<span class="mmm-hpm__fs-section-title">${this.translate("TODAY")}</span>`;
		wrap.appendChild(head);

		const body = document.createElement("div");
		body.className = "mmm-hpm__fs-daily-body";

		const bars = document.createElement("div");
		bars.className = "mmm-hpm__fs-bars";
		const maxWh = Math.max(d.igoWh, d.isiWh, d.ibiWh, 1);
		bars.appendChild(this._fsBar(this.translate("GENERATION"), d.igoWh, maxWh, this.config.colorGeneration));
		bars.appendChild(this._fsBar(this.translate("SELL"), d.isiWh, maxWh, this.config.colorSell));
		bars.appendChild(this._fsBar(this.translate("BUY"), d.ibiWh, maxWh, this.config.colorBuy));
		body.appendChild(bars);

		const net = (d.ismYen || 0) - (d.ibmYen || 0);
		const money = document.createElement("div");
		money.className = "mmm-hpm__fs-money";
		money.appendChild(this._fsMoneyTile(this.translate("SELL_AMOUNT"), this._fmtYen(d.ismYen), this.config.colorSell));
		money.appendChild(this._fsMoneyTile(this.translate("BUY_AMOUNT"), this._fmtYen(d.ibmYen), this.config.colorBuy));
		money.appendChild(this._fsMoneyTile(
			this.translate("NET_BALANCE"),
			this._fmtYen(net),
			net >= 0 ? this.config.colorSell : this.config.colorBuy
		));
		body.appendChild(money);

		wrap.appendChild(body);
		return wrap;
	},

	_fsBar (label, wh, maxWh, color) {
		const row = document.createElement("div");
		row.className = "mmm-hpm__fs-bar-row";
		const pct = Math.max(1.5, Math.min(100, (wh / maxWh) * 100));

		row.innerHTML = `
			<span class="mmm-hpm__fs-bar-label">${label}</span>
			<div class="mmm-hpm__fs-bar-track">
				<div class="mmm-hpm__fs-bar-fill" style="width:${pct}%;--hpm-accent:${color}"></div>
			</div>
			<span class="mmm-hpm__fs-bar-value">${this._fmtKWh(wh)}<small> kWh</small></span>
		`;
		return row;
	},

	_fsMoneyTile (label, value, color) {
		const tile = document.createElement("div");
		tile.className = "mmm-hpm__fs-money-tile";
		tile.style.setProperty("--hpm-accent", color);
		tile.innerHTML = `
			<span class="mmm-hpm__fs-money-label">${label}</span>
			<span class="mmm-hpm__fs-money-value">${value}</span>
		`;
		return tile;
	},

	_fsFooter () {
		const footer = document.createElement("div");
		footer.className = "mmm-hpm__fs-footer";

		if (this.config.showLifetimeTotal && this.total) {
			const t = this.total;
			const totals = document.createElement("div");
			totals.className = "mmm-hpm__fs-totals";
			totals.innerHTML = `
				<span class="mmm-hpm__fs-total-item"><em>${this.translate("LIFETIME")} ${this.translate("GENERATION")}</em><b>${this._fmtKWh(t.tgtWh)}<small> kWh</small></b></span>
				<span class="mmm-hpm__fs-total-item"><em>${this.translate("SELL")}</em><b>${this._fmtKWh(t.tstWh)}<small> kWh</small></b></span>
				<span class="mmm-hpm__fs-total-item"><em>${this.translate("BUY")}</em><b>${this._fmtKWh(t.tbtWh)}<small> kWh</small></b></span>
			`;
			footer.appendChild(totals);
		}

		footer.appendChild(this._buildMetaSection());
		return footer;
	},

	_buildMetaSection () {
		const meta = document.createElement("div");
		meta.className = "mmm-hpm__meta";

		if (this.lastError) {
			meta.classList.add("mmm-hpm__meta--error");
			const isAuthError = /401|403|Unauthorized|authentication/i.test(this.lastError);
			const label = isAuthError ? this.translate("AUTH_ERROR") : `${this.translate("CONNECTION_ERROR")}: ${this.lastError}`;
			meta.innerHTML = `<span class="mmm-hpm__meta-icon">⚠️</span> ${label}`;
			return meta;
		}

		if (this.config.showLastUpdated && this.lastUpdated) {
			const time = new Date(this.lastUpdated);
			const hh = String(time.getHours()).padStart(2, "0");
			const mm = String(time.getMinutes()).padStart(2, "0");
			const ss = String(time.getSeconds()).padStart(2, "0");
			meta.innerHTML = `<span class="mmm-hpm__meta-dot mmm-hpm__meta-dot--ok"></span>${this.translate("UPDATED")}: ${hh}:${mm}:${ss}`;
		}

		return meta;
	}
});
