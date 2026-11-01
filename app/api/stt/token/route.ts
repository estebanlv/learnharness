/**
 * POST-less BYOK mint: the renderer never holds the real Deepgram key.
 *
 * The key lives server-side only (auth.json → process.env in the desktop
 * app; .env.local in dev — same seam as OPENROUTER_API_KEY). A dictation
 * run starts here: mint a short-lived access token (TTL 300s — a run can
 * outlast the 30s default), the renderer opens its WebSocket to Deepgram
 * with it, and audio flows renderer → Deepgram directly, never through
 * this server. The token is only checked at the WebSocket handshake, so
 * long dictation sessions survive the TTL fine (Deepgram docs).
 *
 * NOTE: the key needs ≥ Member permission in the Deepgram console to call
 * /auth/grant (their docs, token-based auth FAQ) — plain read/transcribe
 * keys return FORBIDDEN here.
 */
import { keyValue } from "@/src/server";

export async function GET() {
	const key = keyValue("DEEPGRAM_API_KEY");
	if (!key) {
		return Response.json(
			{ message: "No DEEPGRAM_API_KEY — add it to auth.json (desktop) or .env.local (dev)." },
			{ status: 503 },
		);
	}

	try {
		const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
			method: "POST",
			headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl_seconds: 300 }),
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) {
			await res.body?.cancel();
			console.warn("[dictation] Deepgram token grant rejected", { status: res.status });
			return Response.json(
				{ message: `Deepgram token grant failed (${res.status})`, retryable: res.status === 408 || res.status === 429 || res.status >= 500 },
				{ status: 502 },
			);
		}
		const data = (await res.json()) as { access_token?: string };
		if (!data.access_token) {
			return Response.json({ message: "Deepgram grant returned no token", retryable: true }, { status: 502 });
		}
		return Response.json({ token: data.access_token });
	} catch (error) {
		// Error messages and request objects may contain credentials. Record only
		// the exception type and network code (e.g. ETIMEDOUT / ECONNRESET).
		const failure = error as { name?: string; cause?: { code?: string } } | null;
		console.warn("[dictation] Deepgram token request failed", { name: failure?.name, code: failure?.cause?.code });
		return Response.json({ message: "Deepgram unreachable", retryable: true }, { status: 502 });
	}
}
