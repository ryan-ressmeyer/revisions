// Figure files as image URLs for the rich view. The bytes come through the
// API client (with the token) and are shown through blob URLs.
import { getDocument } from "pdfjs-dist";
import type { RepoId } from "../api/client";
import { getFile } from "../api/repo";

const types: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	svg: "image/svg+xml",
};

// ponytail: cached by path for the page's lifetime; a figure replaced on
// disk shows its old version until the page is reloaded. Key by the file's
// hash once `GET R/state` reports hashes for images.
const cache = new Map<string, Promise<string>>();

/**
 * A URL showing the figure at `path`: its own bytes for PNG, JPEG, GIF and
 * SVG, or the first page of a PDF drawn to a PNG. Rejects for other formats.
 */
export function figureUrl(id: RepoId, path: string): Promise<string> {
	const key = `${id}\n${path}`;
	let url = cache.get(key);
	if (!url) {
		url = load(id, path);
		url.catch(() => cache.delete(key));
		cache.set(key, url);
	}
	return url;
}

async function load(id: RepoId, path: string): Promise<string> {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const type = types[ext];
	if (!type && ext !== "pdf") throw new Error(`Cannot show .${ext} figures.`);
	const { bytes } = await getFile(id, path);
	// An SVG is a document that can hold script. A blob: URL has the app's
	// origin, so an SVG opened from it on its own (Open image in new tab)
	// could read the page token; a data: URL opens in an opaque origin.
	if (ext === "svg") return dataUrl(new Blob([bytes], { type }));
	if (type) return URL.createObjectURL(new Blob([bytes], { type }));
	const task = getDocument({ data: new Uint8Array(bytes) });
	try {
		const page = await (await task.promise).getPage(1);
		const base = page.getViewport({ scale: 1 });
		const viewport = page.getViewport({ scale: 1200 / base.width });
		const canvas = document.createElement("canvas");
		canvas.width = Math.floor(viewport.width);
		canvas.height = Math.floor(viewport.height);
		await page.render({ canvas, viewport }).promise;
		const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r));
		if (!blob) throw new Error("The PDF figure could not be drawn.");
		return URL.createObjectURL(blob);
	} finally {
		task.destroy();
	}
}

function dataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}
