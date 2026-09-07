const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// Mock global environment for MagicMirror module
global.Module = {
	register (name, definition) {
		global.Module.definition = definition;
	}
};
global.Log = { info () {}, log () {}, error () {} };

// Intercept MagicMirror runtime modules (node_helper, logger)
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "node_helper") {
		return {
			create (def) {
				return def;
			}
		};
	}
	if (request === "logger") {
		return global.Log;
	}
	return originalLoad.apply(this, arguments);
};

// Load main module
require("../MMM-HomePowerMonitor_forPanasonic.js");

test("MMM-HomePowerMonitor_forPanasonic _fmtYen formatting", () => {
	const moduleDef = global.Module.definition;
	const instance = Object.assign({
		config: Object.assign({}, moduleDef.defaults)
	}, moduleDef);

	// Test default formatting (1 decimal place)
	assert.strictEqual(instance._fmtYen(500), "¥500.0");
	assert.strictEqual(instance._fmtYen(500.5), "¥500.5");
	assert.strictEqual(instance._fmtYen(-451.2), "-¥451.2");

	// Test custom decimalsCurrency = 0
	instance.config.decimalsCurrency = 0;
	assert.strictEqual(instance._fmtYen(500), "¥500");
	assert.strictEqual(instance._fmtYen(-451), "-¥451");

	// Test custom decimalsCurrency = 2
	instance.config.decimalsCurrency = 2;
	assert.strictEqual(instance._fmtYen(500.5), "¥500.50");
});

test("node_helper daily data processing divides ISM and IBM by 10", async () => {
	const helper = require("../node_helper.js");

	helper.instances = {
		test_id: {
			config: { ipAddress: "127.0.0.1", deviceId: "TEST", username: "u", password: "p" }
		}
	};

	let notificationSent = null;
	helper.sendSocketNotification = (name, payload) => {
		notificationSent = { name, payload };
	};

	helper._request = async () => {
		// Mock response array: res[3]=8400, res[4]=900, res[5]=5000 (0.1 yen), res[6]=15400, res[7]=4780 (0.1 yen)
		return ["00000000000000", "258", "TEST", "8400", "900", "5000", "15400", "4780"];
	};

	helper._fetchDaily("test_id");

	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.notStrictEqual(notificationSent, null);
	assert.strictEqual(notificationSent.name, "HPM_DAILY_DATA");
	assert.strictEqual(notificationSent.payload.data.igoWh, 8400);
	assert.strictEqual(notificationSent.payload.data.isiWh, 900);
	assert.strictEqual(notificationSent.payload.data.ismYen, 500.0);
	assert.strictEqual(notificationSent.payload.data.ibiWh, 15400);
	assert.strictEqual(notificationSent.payload.data.ibmYen, 478.0);
});
