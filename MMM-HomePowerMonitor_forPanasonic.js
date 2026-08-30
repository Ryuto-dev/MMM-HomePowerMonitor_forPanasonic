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

		// --- Formatting ---
		currencySymbol: "¥",
		currencyLocale: "ja-JP",
		decimalsRealtime: 1,
		decimalsEnergy: 2,

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
		wrapper.classList.add(this._positionClass());

		if (!this.config.ipAddress || !this.config.deviceId) {
			wrapper.classList.add("mmm-hpm--config-error");
			wrapper.innerHTML = `<div class="mmm-hpm__error">${this.translate("CONFIG_MISSING")}</div>`;
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
		const n = Math.round(Number(yen) || 0);
		return `${this.config.currencySymbol}${n.toLocaleString(this.config.currencyLocale)}`;
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
		const pct = Math.max(0, Math.min(100, Number(ssr) || 0));
		const radius = 34;
		const circumference = 2 * Math.PI * radius;
		const offset = circumference * (1 - pct / 100);

		const wrap = document.createElement("div");
		wrap.className = "mmm-hpm__ssr-ring";

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
				<span class="mmm-hpm__ssr-pct">${pct.toFixed(0)}%</span>
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

	_buildMetaSection () {
		const meta = document.createElement("div");
		meta.className = "mmm-hpm__meta";

		if (this.lastError) {
			meta.classList.add("mmm-hpm__meta--error");
			meta.innerHTML = `<span class="mmm-hpm__meta-icon">⚠️</span> ${this.translate("CONNECTION_ERROR")}: ${this.lastError}`;
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
