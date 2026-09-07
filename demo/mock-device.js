/*
 * mock-device.js
 *
 * A tiny standalone HTTP server that emulates a Panasonic energy-monitor
 * power detection unit's `getinfo.cgi` endpoint, so the module can be
 * developed and previewed without real hardware.
 *
 * Like the real hardware, the endpoint is protected with HTTP Basic
 * authentication.
 *
 * Usage:
 *   node demo/mock-device.js [port] [username] [password]
 *
 * Then set in config.js:
 *   ipAddress: "127.0.0.1", port: <port>, deviceId: "17120385X",
 *   username: "user", password: "12345678"
 */

const http = require("http");

const PORT = parseInt(process.argv[2], 10) || 9998;
const USERNAME = process.argv[3] || "user";
const PASSWORD = process.argv[4] || "12345678";
const DEVICE_ID = "17120385X";

function isAuthorized (req) {
	const header = req.headers.authorization || "";
	const match = header.match(/^Basic\s+(.+)$/i);
	if (!match) {
		return false;
	}
	const decoded = Buffer.from(match[1], "base64").toString("utf8");
	const sep = decoded.indexOf(":");
	const user = sep === -1 ? decoded : decoded.slice(0, sep);
	const pass = sep === -1 ? "" : decoded.slice(sep + 1);
	return user === USERNAME && pass === PASSWORD;
}

function randomWalk (value, min, max, step) {
	let v = value + (Math.random() - 0.5) * step;
	if (v < min) v = min;
	if (v > max) v = max;
	return v;
}

const state = {
	igo: 800, // generation W
	isi: 0, // sell W
	ibi: 400, // buy W
	dayIgoWh: 4200,
	dayIbiWh: 15400,
	dayIsiWh: 900,
	totalGtWh: 12500000,
	totalStWh: 4300000,
	totalBtWh: 9800000
};

function tick () {
	state.igo = Math.max(0, randomWalk(state.igo, 0, 3500, 250));
	const homeLoad = Math.max(50, randomWalk(700, 100, 1800, 300));
	if (state.igo > homeLoad) {
		state.isi = state.igo - homeLoad;
		state.ibi = 0;
	} else {
		state.ibi = homeLoad - state.igo;
		state.isi = 0;
	}
}
setInterval(tick, 3000);
tick();

function respond (res, items) {
	const parts = ["00000000000000", "258", DEVICE_ID];

	items.forEach((item) => {
		switch (item) {
			case "IG0":
				parts.push(Math.round(state.igo * 10) / 10);
				break;
			case "ISI":
				parts.push(Math.round(state.isi * 10) / 10);
				break;
			case "IBI":
				parts.push(Math.round(state.ibi * 10) / 10);
				break;
			case "ISM":
				parts.push(Math.round(state.dayIsiWh * 0.3));
				break;
			case "IBM":
				parts.push(Math.round(state.dayIbiWh * 0.31));
				break;
			case "TGT":
				parts.push(state.totalGtWh);
				break;
			case "TST":
				parts.push(state.totalStWh);
				break;
			case "TBT":
				parts.push(state.totalBtWh);
				break;
			default:
				parts.push(0);
		}
	});

	const body = `{${parts.join("&")}}`;
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end(body);
}

const server = http.createServer((req, res) => {
	if (!isAuthorized(req)) {
		res.writeHead(401, {
			"WWW-Authenticate": "Basic realm=\"energy-monitor\"",
			"Content-Type": "text/plain"
		});
		res.end("401 Unauthorized");
		return;
	}

	const url = new URL(req.url, `http://${req.headers.host}`);
	if (url.pathname !== "/getinfo.cgi") {
		res.writeHead(404);
		res.end("not found");
		return;
	}

	// Query is not standard key=value; it's raw &-joined tokens after '?'.
	const raw = url.search.replace(/^\?/, "");
	const tokens = raw.split("&");
	// tokens: [deviceId, slot, dateFrom, dateTo, ...items]
	const items = tokens.slice(4);

	// crude Wh drift so daily/total screens show believable numbers too
	if (items.includes("IG0") && tokens[2] !== "0000") {
		// daily/monthly/yearly path — use accumulated Wh instead of realtime W
		respond(res, items.map((i) => (i === "IG0" ? "IG0" : i)));
		return;
	}

	respond(res, items);
});

server.listen(PORT, () => {
	console.log(`Mock Panasonic energy-monitor device listening on http://127.0.0.1:${PORT}/getinfo.cgi`);
	console.log(`Device ID: ${DEVICE_ID}`);
	console.log(`Basic auth: ${USERNAME} / ${PASSWORD}`);
});
