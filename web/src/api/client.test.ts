// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, ping } from "./client";

function respondWith(status: number, body: string) {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
		return new Response(body, { status });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.head.innerHTML = "";
});

test("sends the page token and returns the JSON body", async () => {
	document.head.innerHTML = '<meta name="revisions-token" content="tok123">';
	const fetchMock = respondWith(200, '{"app":"revisions","version":"1.2.3"}');

	expect(await ping()).toEqual({ app: "revisions", version: "1.2.3" });
	const [url, init] = fetchMock.mock.calls[0] ?? [];
	expect(url).toBe("/api/ping");
	expect(new Headers(init?.headers).get("X-Revisions-Token")).toBe("tok123");
});

test("turns an error body into an ApiError with its extra fields", async () => {
	respondWith(
		409,
		'{"error":{"code":"stale","message":"The file changed on disk.","hash":"abc"}}',
	);

	const error = await ping().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(ApiError);
	expect(error).toMatchObject({
		status: 409,
		code: "stale",
		message: "The file changed on disk.",
		extra: { hash: "abc" },
	});
});

test("reports a non-JSON error response as an ApiError", async () => {
	respondWith(502, "<html>Bad Gateway</html>");

	const error = await ping().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(ApiError);
	expect(error).toMatchObject({ status: 502, code: "unknown", extra: {} });
});
