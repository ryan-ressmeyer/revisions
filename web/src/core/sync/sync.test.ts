import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createFileSync } from "./sync";

const hashOf = (text: string) => `#${text}`;

/** An in-memory file that applies the server's stale-write rule. */
function fakeDisk(initial: string) {
	let gate: Promise<void> | null = null;
	let inFlight = 0;
	const disk = {
		text: initial,
		/** Every text a save carried, accepted or not. */
		saves: [] as string[],
		loads: 0,
		maxSavesInFlight: 0,
		/** When set, saves reject with it. */
		failure: null as unknown,
		/** Holds saves and loads in flight until the returned function runs. */
		hold() {
			let release = () => {};
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => {
				gate = null;
				release();
			};
		},
		async save(baseHash: string, text: string) {
			disk.saves.push(text);
			inFlight++;
			disk.maxSavesInFlight = Math.max(disk.maxSavesInFlight, inFlight);
			await gate;
			inFlight--;
			if (disk.failure) throw disk.failure;
			if (baseHash !== hashOf(disk.text)) {
				throw Object.assign(new Error("stale"), { code: "stale" });
			}
			disk.text = text;
			return { hash: hashOf(text), written: true };
		},
		async load() {
			disk.loads++;
			await gate;
			return { text: disk.text, hash: hashOf(disk.text) };
		},
	};
	return disk;
}

function open(initial: string, readOnly = false) {
	const disk = fakeDisk(initial);
	const sync = createFileSync(
		{
			save: disk.save,
			load: disk.load,
			schedule: (fn, ms) => {
				const id = setTimeout(fn, ms);
				return () => clearTimeout(id);
			},
		},
		{ text: initial, hash: hashOf(initial), readOnly },
	);
	return { disk, sync };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

test("autosaves 1 s after the last change", async () => {
	const { disk, sync } = open("one");
	expect(sync.getState().status).toBe("saved");

	sync.edit("one two");
	expect(sync.getState().status).toBe("unsaved");
	await advance(600);
	sync.edit("one two three");
	await advance(999);
	expect(disk.saves).toEqual([]);

	await advance(1);
	expect(disk.text).toBe("one two three");
	expect(sync.getState()).toMatchObject({
		status: "saved",
		text: "one two three",
		baseHash: hashOf("one two three"),
	});
});

test("queues edits made during a save and never overlaps saves", async () => {
	const { disk, sync } = open("a");
	const release = disk.hold();
	sync.edit("ab");
	await advance(1000);
	expect(sync.getState().status).toBe("saving");

	sync.edit("abc");
	await advance(5000);
	expect(disk.saves).toEqual(["ab"]);

	release();
	await advance(0);
	// The second save was accepted, so it carried the first save's hash.
	expect(disk.text).toBe("abc");
	expect(disk.saves).toEqual(["ab", "abc"]);
	expect(disk.maxSavesInFlight).toBe(1);
	expect(sync.getState().status).toBe("saved");
});

test("flush saves immediately and resolves when nothing is pending", async () => {
	const { disk, sync } = open("a");
	await sync.flush();
	expect(disk.saves).toEqual([]);

	sync.edit("ab");
	await sync.flush();
	expect(disk.text).toBe("ab");
	expect(sync.getState().status).toBe("saved");

	await advance(5000);
	expect(disk.saves).toEqual(["ab"]);
});

test("flush waits for the save in flight, then saves the queued edits", async () => {
	const { disk, sync } = open("a");
	const release = disk.hold();
	sync.edit("ab");
	await advance(1000);
	sync.edit("abc");

	let flushed = false;
	const flushing = sync.flush().then(() => {
		flushed = true;
	});
	await advance(0);
	expect(flushed).toBe(false);

	release();
	await flushing;
	expect(disk.text).toBe("abc");
	expect(disk.maxSavesInFlight).toBe(1);
});

test("Clean reload: a disk change with no pending edits is adopted silently", async () => {
	const { disk, sync } = open("a");
	disk.text = "changed outside";
	sync.diskChanged(hashOf(disk.text));
	await advance(0);
	expect(sync.getState()).toMatchObject({
		status: "saved",
		text: "changed outside",
		baseHash: hashOf("changed outside"),
		loadCount: 1,
	});

	sync.diskChanged(hashOf(disk.text));
	await advance(0);
	expect(disk.loads).toBe(1);
});

test("a poll that predates the last save does not replace the editor text", async () => {
	const { sync } = open("a");
	sync.edit("ab");
	await sync.flush();

	sync.diskChanged(hashOf("a"));
	await advance(0);
	expect(sync.getState()).toMatchObject({ text: "ab", loadCount: 0 });
});

test("Collision: a stale save keeps the rejected text and stops autosave until reload", async () => {
	const { disk, sync } = open("a");
	sync.edit("a mine");
	disk.text = "a theirs";
	sync.diskChanged(hashOf(disk.text));
	await advance(0);
	expect(disk.loads).toBe(0);
	expect(sync.getState().text).toBe("a mine");

	await advance(1000);
	expect(sync.getState()).toMatchObject({
		status: "collision",
		text: "a mine",
	});
	expect(disk.text).toBe("a theirs");
	expect(sync.hasUnsavedWork()).toBe(true);

	sync.edit("a mine more");
	sync.diskChanged(hashOf(disk.text));
	await advance(5000);
	expect(disk.saves).toEqual(["a mine"]);
	expect(sync.getState()).toMatchObject({
		status: "collision",
		text: "a mine more",
	});
	await expect(sync.flush()).rejects.toThrow();

	await sync.reload();
	expect(sync.getState()).toMatchObject({
		status: "saved",
		text: "a theirs",
		baseHash: hashOf("a theirs"),
		loadCount: 1,
	});
	expect(sync.hasUnsavedWork()).toBe(false);

	sync.edit("a theirs and mine");
	await sync.flush();
	expect(disk.text).toBe("a theirs and mine");
});

test("an edit made while a silent reload is in flight is not overwritten", async () => {
	const { disk, sync } = open("a");
	disk.text = "theirs";
	const release = disk.hold();
	sync.diskChanged(hashOf(disk.text));
	sync.edit("mine");
	release();
	await advance(0);
	expect(sync.getState()).toMatchObject({ status: "unsaved", text: "mine" });

	await advance(1000);
	expect(sync.getState()).toMatchObject({ status: "collision", text: "mine" });
	expect(disk.text).toBe("theirs");
});

test("a failed save keeps the text and retries on the next edit or flush", async () => {
	const { disk, sync } = open("a");
	disk.failure = new Error("network down");
	sync.edit("ab");
	await advance(1000);
	expect(sync.getState()).toMatchObject({
		status: "error",
		text: "ab",
		error: "network down",
	});
	expect(sync.hasUnsavedWork()).toBe(true);
	await advance(10_000);
	expect(disk.saves).toEqual(["ab"]);

	await expect(sync.flush()).rejects.toThrow("network down");
	disk.failure = null;
	await sync.flush();
	expect(disk.text).toBe("ab");
	expect(sync.getState()).toMatchObject({ status: "saved", error: null });

	disk.failure = new Error("network down");
	sync.edit("abc");
	await advance(1000);
	expect(sync.getState().status).toBe("error");
	disk.failure = null;
	sync.edit("abcd");
	await advance(1000);
	expect(disk.text).toBe("abcd");
	expect(sync.getState().status).toBe("saved");
});

test("Close with pending edits: unsaved work lasts from the first edit until the save is confirmed", async () => {
	const { disk, sync } = open("a");
	expect(sync.hasUnsavedWork()).toBe(false);

	const release = disk.hold();
	sync.edit("ab");
	expect(sync.hasUnsavedWork()).toBe(true);
	await advance(1000);
	expect(sync.getState().status).toBe("saving");
	expect(sync.hasUnsavedWork()).toBe(true);

	release();
	await advance(0);
	expect(sync.hasUnsavedWork()).toBe(false);
});

test("a read-only file is never saved", async () => {
	const { disk, sync } = open("caf�", true);
	expect(sync.getState().status).toBe("read-only");
	expect(sync.hasUnsavedWork()).toBe(false);
	await sync.flush();

	sync.edit("typed anyway");
	await advance(5000);
	await expect(sync.flush()).rejects.toThrow();
	expect(disk.saves).toEqual([]);
	expect(sync.getState().status).toBe("read-only");
});

test("a save refused as not UTF-8 makes the file read-only", async () => {
	const { disk, sync } = open("a");
	disk.failure = Object.assign(new Error("not utf-8"), { code: "not_utf8" });
	sync.edit("ab");
	await advance(1000);
	expect(sync.getState().status).toBe("read-only");

	sync.edit("abc");
	await advance(5000);
	expect(disk.saves).toEqual(["ab"]);
});

test("notifies subscribers and keeps the state reference stable between changes", async () => {
	const { sync } = open("a");
	const seen: string[] = [];
	const unsubscribe = sync.subscribe(() => seen.push(sync.getState().status));
	expect(sync.getState()).toBe(sync.getState());

	sync.edit("ab");
	const unsaved = sync.getState();
	sync.edit("ab");
	expect(sync.getState()).toBe(unsaved);
	await sync.flush();
	expect(seen).toEqual(["unsaved", "saving", "saved"]);

	unsubscribe();
	sync.edit("abc");
	expect(seen).toHaveLength(3);
});
