// The save and reload state machine for one open file: a pure reducer and a
// thin driver whose I/O and timer are injected. Nothing here touches browser
// storage.

/** Autosave runs this long after the last change. */
export const AUTOSAVE_DELAY_MS = 1000;

/** What the UI shows for one open file. */
export type SyncStatus =
	| "saved"
	| "unsaved"
	| "saving"
	| "collision"
	| "error"
	| "read-only";

/** A file as read from disk. */
export interface LoadedFile {
	/** The file's text with `\n` line breaks. */
	text: string;
	/** `X-Revisions-Hash` of the bytes the text was decoded from. */
	hash: string;
	/** True for a file that is not valid UTF-8. It is shown and never saved. */
	readOnly?: boolean;
}

/** The state of one open file. A new object is made on every change. */
export interface SyncState {
	readonly status: SyncStatus;
	/**
	 * The latest text: the disk contents after a load, otherwise the last
	 * edit. During `collision` this is the rejected text to show for copying.
	 */
	readonly text: string;
	/** Hash of the disk version that `text` is based on. */
	readonly baseHash: string;
	/** True while `text` holds edits that no save has carried yet. */
	readonly dirty: boolean;
	/**
	 * Counts the times `text` was replaced from disk after opening. When it
	 * changes, the UI replaces the editor document with `text`.
	 */
	readonly loadCount: number;
	/** The failure message while `status` is `error`, otherwise null. */
	readonly error: string | null;
}

export type SyncEvent =
	| { type: "edit"; text: string }
	| { type: "saveStarted" }
	| { type: "saveSucceeded"; hash: string }
	/** `code` is the server's error code when it gave one. */
	| { type: "saveFailed"; code?: string; message: string }
	/** `force` adopts the file even over unsaved edits. */
	| { type: "loaded"; file: LoadedFile; force: boolean };

/** The state of a file that was just opened. */
export function initialState(file: LoadedFile): SyncState {
	return {
		status: file.readOnly ? "read-only" : "saved",
		text: file.text,
		baseHash: file.hash,
		dirty: false,
		loadCount: 0,
		error: null,
	};
}

/**
 * True from the first unsaved edit until the server confirms the save, and
 * throughout a collision. The UI wires this to the leave-page warning.
 */
export function hasUnsavedWork(state: SyncState): boolean {
	return state.dirty || state.status === "saving";
}

/** The pure transition function. Returns `state` itself when nothing changes. */
export function reduce(state: SyncState, event: SyncEvent): SyncState {
	switch (event.type) {
		case "edit":
			if (event.text === state.text) return state;
			return {
				...state,
				text: event.text,
				dirty: true,
				error: null,
				status:
					state.status === "saved" || state.status === "error"
						? "unsaved"
						: state.status,
			};
		case "saveStarted":
			return { ...state, status: "saving", dirty: false, error: null };
		case "saveSucceeded":
			return {
				...state,
				baseHash: event.hash,
				status: state.dirty ? "unsaved" : "saved",
			};
		case "saveFailed": {
			const status =
				event.code === "stale"
					? "collision"
					: event.code === "not_utf8"
						? "read-only"
						: "error";
			return {
				...state,
				status,
				dirty: true,
				error: status === "error" ? event.message : null,
			};
		}
		case "loaded":
			if (
				!event.force &&
				(hasUnsavedWork(state) || event.file.hash === state.baseHash)
			) {
				return state;
			}
			return {
				...initialState(event.file),
				loadCount: state.loadCount + 1,
			};
	}
}

/** The I/O and timer the driver needs. */
export interface SyncDeps {
	/**
	 * `PUT R/file`. Resolves with the new hash. Rejects with an error whose
	 * `code` property is `"stale"` or `"not_utf8"` when the server refuses
	 * the save, as the API client's `ApiError` does. Any other rejection
	 * counts as a failure that can be retried.
	 */
	save(baseHash: string, text: string): Promise<{ hash: string }>;
	/** `GET R/file`, decoded. */
	load(): Promise<LoadedFile>;
	/** Runs `fn` once after `ms` milliseconds. Returns a function that cancels it. */
	schedule(fn: () => void, ms: number): () => void;
}

/** The handle the UI holds for one open file. */
export interface FileSync {
	/** The current state. The same object is returned until something changes. */
	getState(): SyncState;
	/** Calls `listener` after every state change. Returns the unsubscribe function. */
	subscribe(listener: () => void): () => void;
	/**
	 * Records the editor's full text after a change and schedules an autosave
	 * 1 s later. A call with the text already held does nothing, so echoing
	 * a reload back is harmless.
	 */
	edit(text: string): void;
	/**
	 * Saves now and resolves once every edit is on disk. Call it before a
	 * build or a Git operation. Rejects when the save fails or is refused,
	 * and when the file is in collision or read-only with unsaved edits;
	 * `getState().status` then says why.
	 */
	flush(): Promise<void>;
	/**
	 * Reports the file's hash from a `GET R/state` poll. A hash that differs
	 * from the base hash reloads the file when it has no unsaved work.
	 * With unsaved work nothing happens; the next save is rejected as stale.
	 */
	diskChanged(hash: string): void;
	/**
	 * Adopts the disk contents and discards local edits. This is the Reload
	 * button of a collision. Rejects when the load fails, leaving the state
	 * as it was.
	 */
	reload(): Promise<void>;
	/** See {@link hasUnsavedWork}. */
	hasUnsavedWork(): boolean;
}

/** Starts syncing one open file whose contents were just loaded as `file`. */
export function createFileSync(deps: SyncDeps, file: LoadedFile): FileSync {
	let state = initialState(file);
	const listeners = new Set<() => void>();
	let cancelAutosave: (() => void) | null = null;
	/** The save in flight. Resolves true when the server accepted it. */
	let inFlight: Promise<boolean> | null = null;

	const dispatch = (event: SyncEvent) => {
		const next = reduce(state, event);
		if (next === state) return;
		state = next;
		for (const listener of listeners) listener();
	};

	const stopAutosave = () => {
		cancelAutosave?.();
		cancelAutosave = null;
	};

	const savable = () =>
		state.dirty && (state.status === "unsaved" || state.status === "error");

	// Callers check that no save is in flight, so saves never overlap.
	const save = (): Promise<boolean> => {
		const { baseHash, text } = state;
		dispatch({ type: "saveStarted" });
		inFlight = (async () => {
			try {
				const { hash } = await deps.save(baseHash, text);
				inFlight = null;
				dispatch({ type: "saveSucceeded", hash });
				return true;
			} catch (error) {
				inFlight = null;
				const { code, message } = error as {
					code?: unknown;
					message?: unknown;
				};
				dispatch({
					type: "saveFailed",
					code: typeof code === "string" ? code : undefined,
					message: typeof message === "string" ? message : String(error),
				});
				return false;
			}
		})();
		return inFlight;
	};

	const autosave = async () => {
		cancelAutosave = null;
		while (inFlight) await inFlight;
		if (savable()) await save();
	};

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		edit(text) {
			const before = state;
			dispatch({ type: "edit", text });
			if (state === before) return;
			stopAutosave();
			cancelAutosave = deps.schedule(autosave, AUTOSAVE_DELAY_MS);
		},
		async flush() {
			stopAutosave();
			for (;;) {
				while (inFlight) await inFlight;
				if (!state.dirty) return;
				if (!savable() || !(await save())) {
					throw new Error(state.error ?? `Save refused: ${state.status}.`);
				}
			}
		},
		diskChanged(hash) {
			if (hash === state.baseHash || hasUnsavedWork(state)) return;
			// A failed load is retried by the next poll.
			deps.load().then(
				(loaded) => dispatch({ type: "loaded", file: loaded, force: false }),
				() => {},
			);
		},
		async reload() {
			stopAutosave();
			while (inFlight) await inFlight;
			const loaded = await deps.load();
			dispatch({ type: "loaded", file: loaded, force: true });
		},
		hasUnsavedWork: () => hasUnsavedWork(state),
	};
}
