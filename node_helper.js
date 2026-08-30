/*
 * node_helper.js for MMM-HomePowerMonitor_forPanasonic
 *
 * Talks to the Panasonic energy-monitor power detection unit (e.g. VBPX274)
 * over plain HTTP using the device's `getinfo.cgi` interface and forwards
 * parsed results back to the front-end module via socket notifications.
 *
 * Device API reference (as supplied by the user):
 *   GET http://<ip>/getinfo.cgi?<deviceId>&<slot>&<dateFrom>&<dateTo>&<items...>
 *
 *   Response body looks like: {status&aux&deviceId&v3&v4&v5&...}
 *     res[0] = internal status string
 *     res[1] = aux value
 *     res[2] = echoed device id
 *     res[3..] = requested items, in the order they were requested
 */

const http = require("http");
const NodeHelper = require("node_helper");
const Log = require("logger");

module.exports = NodeHelper.create({
	start () {
		Log.log(`${this.name} helper started...`);
		// One timer-set per module instance (identifier), so multiple
		// instances of this module (e.g. different devices) don't collide.
		this.instances = {};
	},

	stop () {
		Object.keys(this.instances).forEach((id) => this._clearTimers(id));
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "HPM_INIT" || !payload || !payload.identifier) {
			return;
		}

		const { identifier, config } = payload;

		// (Re)initialize this instance's state & schedule.
		this._clearTimers(identifier);
		this.instances[identifier] = { config, timers: {} };

		this._fetchRealtime(identifier);
		this.instances[identifier].timers.realtime = setInterval(
			() => this._fetchRealtime(identifier),
			Math.max(config.updateInterval || 5000, 1000)
		);

		if (config.showDaily) {
			this._fetchDaily(identifier);
			this.instances[identifier].timers.daily = setInterval(
				() => this._fetchDaily(identifier),
				Math.max(config.dailyUpdateInterval || 60000, 5000)
			);
		}

		if (config.showLifetimeTotal) {
			this._fetchTotal(identifier);
			this.instances[identifier].timers.total = setInterval(
				() => this._fetchTotal(identifier),
				Math.max(config.totalUpdateInterval || 600000, 30000)
			);
		}
	},

	_clearTimers (identifier) {
		const inst = this.instances[identifier];
		if (!inst) {
			return;
		}
		Object.values(inst.timers || {}).forEach((t) => clearInterval(t));
	},

	// ------------------------------------------------------------------
	// Requests
	// ------------------------------------------------------------------

	_fetchRealtime (identifier) {
		const inst = this.instances[identifier];
		if (!inst) {
			return;
		}
		const { config } = inst;

		this._request(config, "0000", "0000", ["IG0", "ISI", "IBI"])
			.then((res) => {
				const igo = this._num(res[3]);
				const isi = this._num(res[4]);
				const ibi = this._num(res[5]);

				let aoc = igo + ibi - isi;
				if (aoc < 0 || Number.isNaN(aoc)) {
					aoc = 0;
				}

				let ssr = 0;
				if (aoc > 0) {
					ssr = Math.min((igo / aoc) * 100, 100);
				} else if (igo > 0) {
					ssr = 100;
				}

				const status = isi >= ibi ? "selling" : "buying";

				this.sendSocketNotification("HPM_REALTIME_DATA", {
					identifier,
					timestamp: Date.now(),
					data: { igo, isi, ibi, aoc, ssr, status }
				});
			})
			.catch((err) => this._handleError(identifier, err));
	},

	_fetchDaily (identifier) {
		const inst = this.instances[identifier];
		if (!inst) {
			return;
		}
		const { config } = inst;
		const dateCode = this._todayCode();

		this._request(config, dateCode, dateCode, ["IG0", "ISI", "ISM", "IBI", "IBM"])
			.then((res) => {
				const igoWh = this._num(res[3]);
				const isiWh = this._num(res[4]);
				const ismYen = this._num(res[5]);
				const ibiWh = this._num(res[6]);
				const ibmYen = this._num(res[7]);

				this.sendSocketNotification("HPM_DAILY_DATA", {
					identifier,
					timestamp: Date.now(),
					data: { igoWh, isiWh, ismYen, ibiWh, ibmYen }
				});
			})
			.catch((err) => this._handleError(identifier, err));
	},

	_fetchTotal (identifier) {
		const inst = this.instances[identifier];
		if (!inst) {
			return;
		}
		const { config } = inst;

		this._request(config, "0000", "0000", ["TGT", "TST", "TBT"])
			.then((res) => {
				const tgtWh = this._num(res[3]);
				const tstWh = this._num(res[4]);
				const tbtWh = this._num(res[5]);

				this.sendSocketNotification("HPM_TOTAL_DATA", {
					identifier,
					timestamp: Date.now(),
					data: { tgtWh, tstWh, tbtWh }
				});
			})
			.catch((err) => this._handleError(identifier, err));
	},

	_handleError (identifier, err) {
		const inst = this.instances[identifier];
		const message = (err && err.message) || String(err);
		if (inst && inst.config && inst.config.debug) {
			Log.error(`[MMM-HomePowerMonitor_forPanasonic] ${message}`);
		}
		this.sendSocketNotification("HPM_ERROR", { identifier, message });
	},

	// ------------------------------------------------------------------
	// HTTP / parsing helpers
	// ------------------------------------------------------------------

	/**
	 * Builds and performs the getinfo.cgi request.
	 * @param {object} config module config (ipAddress, deviceId, port, requestTimeout)
	 * @param {string} dateFrom first date/code argument
	 * @param {string} dateTo second date/code argument
	 * @param {string[]} items list of item codes to request (e.g. ["IG0","ISI","IBI"])
	 * @returns {Promise<string[]>} parsed response array (res[0..n])
	 */
	_request (config, dateFrom, dateTo, items) {
		return new Promise((resolve, reject) => {
			if (!config.ipAddress || !config.deviceId) {
				reject(new Error("ipAddress/deviceId not configured"));
				return;
			}

			const query = [config.deviceId, "0", dateFrom, dateTo, ...items].join("&");
			const path = `/getinfo.cgi?${query}`;
			const port = config.port || 80;

			const req = http.get(
				{
					hostname: config.ipAddress,
					port,
					path,
					timeout: config.requestTimeout || 5000
				},
				(res) => {
					const chunks = [];
					res.on("data", (chunk) => chunks.push(chunk));
					res.on("end", () => {
						const body = Buffer.concat(chunks).toString("utf8");
						try {
							resolve(this._parseResponse(body));
						} catch (parseErr) {
							reject(parseErr);
						}
					});
				}
			);

			req.on("timeout", () => {
				req.destroy(new Error("Request timed out"));
			});

			req.on("error", (err) => {
				reject(err);
			});
		});
	},

	/**
	 * Parses a `{a&b&c&...}` style response body into an array of strings.
	 */
	_parseResponse (body) {
		if (!body || typeof body !== "string") {
			throw new Error("Empty response from device");
		}
		const trimmed = body.trim();
		const match = trimmed.match(/\{([^}]*)\}/);
		const content = match ? match[1] : trimmed;
		return content.split("&");
	},

	_num (value) {
		const n = parseFloat(value);
		return Number.isFinite(n) ? n : 0;
	},

	_todayCode () {
		const now = new Date(Date.now());
		const yyyy = now.getFullYear();
		const mm = String(now.getMonth() + 1).padStart(2, "0");
		const dd = String(now.getDate()).padStart(2, "0");
		return `${yyyy}${mm}${dd}`;
	}
});
