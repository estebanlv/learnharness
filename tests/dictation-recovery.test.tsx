import React, { act } from "react";
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { createDictationConnection, DICTATION_RECOVERY_MS, useDictation, type Dictation } from "../components/dictation.tsx";

class FakeSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances: FakeSocket[] = [];
	readyState = 0;
	sent: (string | ArrayBuffer)[] = [];
	failSend = false;
	listeners = new Map<string, ((event: any) => void)[]>();
	constructor(readonly url: string, readonly protocols: string[]) { FakeSocket.instances.push(this); }
	addEventListener(type: string, callback: (event: any) => void) {
		this.listeners.set(type, [...this.listeners.get(type) ?? [], callback]);
	}
	emit(type: string, event: any = {}) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
	open() { this.readyState = 1; this.emit("open"); }
	drop(code = 1006) { this.readyState = 3; this.emit("close", { code }); }
	final(text: string) { this.emit("message", { data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } }) }); }
	send(data: string | ArrayBuffer) { if (this.failSend) throw new Error("send failed"); this.sent.push(data); }
	close() { this.readyState = 3; }
}
const latestSocket = () => FakeSocket.instances.at(-1)!;
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
function fixture(t: TestContext, initialToken = Promise.resolve("initial"), mintToken: () => Promise<string> = async () => "fresh") {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const originalSocket = globalThis.WebSocket;
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	FakeSocket.instances = [];
	t.mock.method(console, "warn", () => {});
	const transcripts: string[] = [], errors: string[] = [];
	let ends = 0, recordings = 0;
	const connection = createDictationConnection({ initialToken, mintToken,
		onTranscript: text => transcripts.push(text), onError: text => errors.push(text),
		onEnd: () => { ends++; }, onRecording: () => { recordings++; } });
	t.after(() => { connection.dispose(); globalThis.WebSocket = originalSocket; });
	connection.start();
	return { connection, transcripts, errors, get ends() { return ends; }, get recordings() { return recordings; } };
}

describe("dictation connection recovery", () => {
	it("retries a failed initial token and delivers speech captured during the outage in order", async t => {
		const f = fixture(t, Promise.reject(new Error("Deepgram unreachable")));
		const first = new ArrayBuffer(16), second = new ArrayBuffer(32);
		f.connection.sendAudio(first);
		await settle();
		f.connection.sendAudio(second);
		assert.equal(f.ends, 0);
		t.mock.timers.tick(250); await settle();
		latestSocket().open();
		assert.deepEqual(latestSocket().sent, [first, second]);
		assert.equal(f.recordings, 1);
		assert.deepEqual(f.errors, []);
	});

	it("recovers repeated interruptions, including code 1000, without ending the run", async t => {
		const f = fixture(t); await settle(); latestSocket().open();
		latestSocket().final("before");
		for (const code of [1000, 1006, 1011]) {
			const previous = latestSocket(); previous.drop(code);
			const gapAudio = new ArrayBuffer(64); f.connection.sendAudio(gapAudio);
			t.mock.timers.tick(250); await settle(); latestSocket().open();
			assert.deepEqual(latestSocket().sent, [gapAudio]);
			previous.final("stale transcript");
			assert.equal(f.ends, 0);
		}
		latestSocket().final("after");
		f.connection.stop(); latestSocket().drop(1000);
		assert.deepEqual(f.transcripts, ["before", "after"]);
		assert.equal(f.ends, 1);
		assert.equal(FakeSocket.instances.length, 4);
	});

	it("sends keepalives and stops them when Stop is pressed; an abnormal stop close does not reconnect", async t => {
		const f = fixture(t); await settle(); latestSocket().open();
		t.mock.timers.tick(9000);
		assert.equal(latestSocket().sent.filter(x => x === '{"type":"KeepAlive"}').length, 3);
		f.connection.stop();
		latestSocket().final("last words"); latestSocket().drop(1006);
		t.mock.timers.tick(30_000); await settle();
		assert.deepEqual(f.transcripts, ["last words"]);
		assert.equal(FakeSocket.instances.length, 1);
		assert.equal(f.ends, 1);
		assert.equal(latestSocket().sent.at(-1), '{"type":"CloseStream"}');
	});

	it("Stop during token recovery ignores a late token and ends exactly once", async t => {
		const token = deferred<string>();
		const f = fixture(t, Promise.resolve("initial"), () => token.promise);
		await settle(); latestSocket().open(); latestSocket().final("saved"); latestSocket().drop();
		t.mock.timers.tick(250); await settle();
		f.connection.stop(); token.resolve("too-late"); await settle();
		t.mock.timers.tick(30_000); await settle();
		assert.equal(FakeSocket.instances.length, 1);
		assert.deepEqual(f.transcripts, ["saved"]);
		assert.equal(f.ends, 1);
	});

	it("dispose cancels recovery and rejects stale callbacks", async t => {
		const token = deferred<string>();
		const f = fixture(t, token.promise);
		f.connection.dispose(); token.resolve("late"); await settle();
		t.mock.timers.tick(30_000); await settle();
		assert.equal(FakeSocket.instances.length, 0);
		assert.equal(f.ends, 0);
		assert.deepEqual(f.errors, []);
	});

	it("caps an interruption at 20 seconds even if token minting never settles", async t => {
		const f = fixture(t, new Promise<string>(() => {}));
		t.mock.timers.tick(DICTATION_RECOVERY_MS - 1); assert.equal(f.ends, 0);
		t.mock.timers.tick(1); assert.equal(f.ends, 1);
		assert.equal(f.errors.length, 1);
		t.mock.timers.tick(30_000); assert.equal(f.ends, 1);
	});

	it("retries a stalled handshake and enforces the original recovery deadline", async t => {
		const f = fixture(t); await settle();
		t.mock.timers.tick(5000); await settle();
		t.mock.timers.tick(250); await settle();
		assert.equal(FakeSocket.instances.length, 2);
		FakeSocket.instances[0]!.open();
		assert.equal(f.recordings, 0, "a replaced socket cannot revive a run");
		t.mock.timers.tick(DICTATION_RECOVERY_MS - 5250); await settle();
		assert.equal(f.ends, 1);
	});

	it("queues the frame when send throws rather than losing it", async t => {
		const f = fixture(t); await settle(); latestSocket().open();
		latestSocket().failSend = true;
		const frame = new ArrayBuffer(16); f.connection.sendAudio(frame);
		t.mock.timers.tick(250); await settle(); latestSocket().open();
		assert.deepEqual(latestSocket().sent, [frame]);
		assert.equal(f.ends, 0);
	});
});

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { React, window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });

async function mount(t: TestContext, fetcher: typeof fetch) {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	FakeSocket.instances = [];
	const originalSocket = globalThis.WebSocket;
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	t.mock.method(globalThis, "fetch", fetcher);
	const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	let trackStops = 0;
	Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { trackStops++; } }] }) } }, configurable: true });
	let worklet!: { port: { onmessage: ((event: any) => void) | null } };
	Object.assign(globalThis, {
		AudioContext: class { state = "running"; destination = {}; audioWorklet = { addModule: async () => {} }; createMediaStreamSource() { return { connect() {}, disconnect() {} }; } },
		AudioWorkletNode: class { port = { onmessage: null }; constructor() { worklet = this; } connect() {} disconnect() {} },
	});
	let live!: Dictation; const appended: string[] = [];
	function Harness() { live = useDictation({ append: text => appended.push(text) }); return null; }
	const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
	t.after(async () => {
		await act(async () => { if (live.active) live.cancel(); });
		await act(async () => root.unmount()); host.remove();
		globalThis.WebSocket = originalSocket;
		if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
	});
	await act(async () => root.render(React.createElement(Harness)));
	return { get live() { return live; }, get worklet() { return worklet; }, get trackStops() { return trackStops; }, appended };
}

describe("mounted dictation recording", () => {
	it("keeps the mic and queued audio through a token outage, then finish waits for the final transcript", async t => {
		const token = deferred<Response>(); let requests = 0;
		const f = await mount(t, async () => ++requests === 1 ? token.promise : Response.json({ token: "fresh" }));
		await act(async () => f.live.toggle());
		const audio = new ArrayBuffer(4096); f.worklet.port.onmessage!({ data: { type: "audio", buffer: audio } });
		await act(async () => token.resolve(Response.json({ message: "Deepgram unreachable", retryable: true }, { status: 502 })));
		assert.equal(f.trackStops, 0); assert.equal(f.live.active, true);
		await act(async () => { t.mock.timers.tick(250); await settle(); });
		await act(async () => latestSocket().open());
		assert.deepEqual(latestSocket().sent, [audio]);
		assert.equal(f.trackStops, 0); assert.equal(f.live.phase, "recording");
		latestSocket().final("first part");
		let finished = false; let finishing!: Promise<void>;
		await act(async () => { finishing = f.live.finish().then(() => { finished = true; }); });
		assert.equal(finished, false); assert.equal(f.trackStops, 1);
		await act(async () => { latestSocket().final("last part"); latestSocket().drop(1000); await finishing; });
		assert.deepEqual(f.appended, ["first part last part"]); assert.equal(finished, true);
		assert.equal(f.live.phase, "idle"); assert.equal(f.live.error, null);
	});

	it("invalid credentials fail immediately without recovery attempts", async t => {
		const f = await mount(t, async () => Response.json({ message: "Deepgram token grant failed (401)", retryable: false }, { status: 502 }));
		await act(async () => f.live.toggle());
		assert.equal(f.live.phase, "idle"); assert.equal(f.trackStops, 1);
		assert.equal(f.live.error, "Deepgram token grant failed (401)");
		await act(async () => { t.mock.timers.tick(30_000); await settle(); });
		assert.equal(FakeSocket.instances.length, 0);
	});

	it("Cancel during reconnect discards text, stops the mic, and ignores the late token", async t => {
		const token = deferred<Response>(); let requests = 0;
		const f = await mount(t, async () => ++requests === 1 ? Response.json({ token: "initial" }) : token.promise);
		await act(async () => f.live.toggle()); await act(async () => latestSocket().open());
		latestSocket().final("discard me");
		await act(async () => latestSocket().drop());
		await act(async () => { t.mock.timers.tick(250); await settle(); });
		assert.equal(f.trackStops, 0);
		await act(async () => f.live.cancel());
		await act(async () => token.resolve(Response.json({ token: "late" })));
		await act(async () => { t.mock.timers.tick(30_000); await settle(); });
		assert.equal(FakeSocket.instances.length, 1); assert.equal(f.trackStops, 1);
		assert.equal(f.live.phase, "idle"); assert.deepEqual(f.appended, []);
	});
});
