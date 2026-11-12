// Loading and saving one open file through core/sync.
import type { RepoId } from "../api/client";
import { getFile, putFile } from "../api/repo";
import {
	createFileSync,
	type FileSync,
	type LoadedFile,
} from "../core/sync/sync";

/**
 * Decodes a file's bytes for the editor. Line breaks become `\n`, as a save
 * expects, and a byte-order mark is dropped (the server keeps the one on
 * disk). Bytes that are not valid UTF-8 open read-only.
 */
export function decodeFile(bytes: ArrayBuffer, hash: string): LoadedFile {
	let text: string;
	let readOnly = false;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		text = new TextDecoder("utf-8").decode(bytes);
		readOnly = true;
	}
	return { text: text.replace(/\r\n?/g, "\n"), hash, readOnly };
}

export async function loadFile(id: RepoId, path: string): Promise<LoadedFile> {
	const { bytes, hash } = await getFile(id, path);
	return decodeFile(bytes, hash);
}

/** Opens `path` and starts syncing it. */
export async function openFileSync(
	id: RepoId,
	path: string,
): Promise<FileSync> {
	const file = await loadFile(id, path);
	return createFileSync(
		{
			save: (baseHash, text) => putFile(id, path, baseHash, text),
			load: () => loadFile(id, path),
			schedule: (fn, ms) => {
				const timer = setTimeout(fn, ms);
				return () => clearTimeout(timer);
			},
		},
		file,
	);
}
