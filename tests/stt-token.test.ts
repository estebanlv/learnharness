import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Route imports compose server stores. Redirect every mutable path before
// loading it, and use only a throwaway key with a completely stubbed fetch.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stt-token-"));
process.env.LH_DATA_DIR = temporary;
process.env.LH_AUTH_FILE = path.join(temporary, "auth.json");
process.env.DEEPGRAM_API_KEY = "dictation-test-key-never-real";
const { GET } = await import("../app/api/stt/token/route.ts");
after(() => {
	assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
	assert.ok(path.basename(temporary).startsWith("lh-stt-token-"));
	fs.rmSync(temporary, { recursive: true, force: true });
});

describe("dictation token route", () => {
	it("mints a short-lived token with a bounded upstream request", async t => {
		t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
			assert.equal(url, "https://api.deepgram.com/v1/auth/grant");
			assert.equal(init.method, "POST");
			assert.ok(init.signal instanceof AbortSignal);
			assert.deepEqual(JSON.parse(init.body as string), { ttl_seconds: 300 });
			return Response.json({ access_token: "temporary-token" });
		});
		const response = await GET();
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { token: "temporary-token" });
	});

	for (const status of [401, 403, 429, 500, 503]) {
		it(`classifies upstream ${status} for recovery without logging credentials`, async t => {
			t.mock.method(globalThis, "fetch", async () => new Response("upstream response", { status }));
			const warn = t.mock.method(console, "warn", () => {});
			const response = await GET();
			assert.equal(response.status, 502);
			const body = await response.json();
			assert.equal(body.retryable, status === 429 || status >= 500);
			assert.doesNotMatch(JSON.stringify(warn.mock.calls), /dictation-test-key-never-real/);
		});
	}

	it("reports a temporary network failure and logs only its type and code", async t => {
		t.mock.method(globalThis, "fetch", async () => { throw Object.assign(new TypeError("sensitive request dictation-test-key-never-real"), { cause: { code: "ECONNRESET" } }); });
		const warn = t.mock.method(console, "warn", () => {});
		const response = await GET();
		assert.deepEqual(await response.json(), { message: "Deepgram unreachable", retryable: true });
		assert.deepEqual(warn.mock.calls[0]!.arguments, ["[dictation] Deepgram token request failed", { name: "TypeError", code: "ECONNRESET" }]);
	});
});
