// The PDF view: every page in one scrolling column, rendered by pdf.js when
// it comes near the screen.
import {
	GlobalWorkerOptions,
	getDocument,
	type PDFDocumentLoadingTask,
	type PDFDocumentProxy,
	type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
	type MouseEvent,
	type Ref,
	type RefObject,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { RepoId } from "../api/client";
import { getPdf, type PdfBox } from "../api/repo";
import { explain } from "./errors";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfHandle {
	/** Scrolls to a SyncTeX box and flashes a highlight over it. */
	show(box: PdfBox): void;
}

interface Size {
	width: number;
	height: number;
}

/** Space around the pages, in CSS pixels. */
const GUTTER = 24;

export function PdfView({
	ref,
	id,
	version,
	zoom,
	onInverse,
}: {
	ref: Ref<PdfHandle>;
	id: RepoId;
	/** The `pdfVersion` to show. A change loads the new PDF in place. */
	version: number;
	/** 1 fits the widest page to the pane. */
	zoom: number;
	/** A double-click or Ctrl/Cmd-click, in PDF points from the page's top-left. */
	onInverse: (page: number, x: number, y: number) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const [doc, setDoc] = useState<{
		proxy: PDFDocumentProxy;
		sizes: Size[];
	} | null>(null);
	const shown = useRef<PDFDocumentLoadingTask | null>(null);
	const [failure, setFailure] = useState("");
	const [width, setWidth] = useState(0);
	const [flash, setFlash] = useState<{ box: PdfBox; n: number } | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new version is a new PDF to fetch
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const task = getDocument({ data: new Uint8Array(await getPdf(id)) });
			const proxy = await task.promise;
			const sizes: Size[] = [];
			for (let n = 1; n <= proxy.numPages; n++) {
				const { width, height } = (await proxy.getPage(n)).getViewport({
					scale: 1,
				});
				sizes.push({ width, height });
			}
			if (cancelled) {
				task.destroy();
				return;
			}
			// The previous document is destroyed only once the next one is ready.
			const previous = shown.current;
			shown.current = task;
			setDoc({ proxy, sizes });
			setFailure("");
			previous?.destroy();
		})().catch((error) => {
			if (!cancelled) setFailure(explain(error));
		});
		return () => {
			cancelled = true;
		};
	}, [id, version]);
	useEffect(() => () => void shown.current?.destroy(), []);

	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const observer = new ResizeObserver(() => setWidth(el.clientWidth));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const widest = Math.max(1, ...(doc?.sizes.map((s) => s.width) ?? [1]));
	const scale = (Math.max(width - 2 * GUTTER, 100) / widest) * zoom;

	// Keep the middle of the view in place when the zoom changes.
	const lastScale = useRef(scale);
	useLayoutEffect(() => {
		const el = scroller.current;
		const before = lastScale.current;
		lastScale.current = scale;
		if (!el || before === scale) return;
		const middle = el.scrollTop + el.clientHeight / 2;
		el.scrollTop = (middle * scale) / before - el.clientHeight / 2;
	}, [scale]);

	useImperativeHandle(
		ref,
		() => ({
			show(box) {
				const el = scroller.current;
				const page = el?.querySelector<HTMLElement>(
					`[data-page="${box.page}"]`,
				);
				if (!el || !page) return;
				el.scrollTo({
					top: page.offsetTop + box.y * scale - el.clientHeight / 3,
					behavior: "smooth",
				});
				setFlash((f) => ({ box, n: (f?.n ?? 0) + 1 }));
			},
		}),
		[scale],
	);

	return (
		<div className="pdf-scroller" ref={scroller}>
			{failure && (
				<p role="alert" className="alert">
					The PDF could not be shown. {failure}
				</p>
			)}
			{doc?.sizes.map((size, i) => (
				<PdfPage
					// biome-ignore lint/suspicious/noArrayIndexKey: pages are identified by their number
					key={i}
					number={i + 1}
					proxy={doc.proxy}
					size={size}
					scale={scale}
					root={scroller}
					flash={flash?.box.page === i + 1 ? flash : null}
					onInverse={onInverse}
				/>
			))}
		</div>
	);
}

function PdfPage({
	number,
	proxy,
	size,
	scale,
	root,
	flash,
	onInverse,
}: {
	number: number;
	proxy: PDFDocumentProxy;
	size: Size;
	scale: number;
	root: RefObject<HTMLDivElement | null>;
	flash: { box: PdfBox; n: number } | null;
	onInverse: (page: number, x: number, y: number) => void;
}) {
	const holder = useRef<HTMLDivElement>(null);
	const [near, setNear] = useState(false);
	const rendered = useRef<{ proxy: PDFDocumentProxy; scale: number } | null>(
		null,
	);

	useEffect(() => {
		const el = holder.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			([entry]) => setNear(entry?.isIntersecting ?? false),
			{ root: root.current, rootMargin: "100% 0px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [root]);

	// ponytail: a page's canvas is kept after it scrolls away, so a long
	// document at high zoom holds every page it has shown. Drop far canvases
	// if memory becomes a problem.
	useEffect(() => {
		const r = rendered.current;
		if (!near || (r?.proxy === proxy && r.scale === scale)) return;
		let cancelled = false;
		let task: RenderTask | null = null;
		(async () => {
			const page = await proxy.getPage(number);
			if (cancelled) return;
			// Render at device pixels so text is crisp on HiDPI screens. The new
			// canvas replaces the old one only when complete, so a rebuild does
			// not flash.
			const viewport = page.getViewport({
				scale: scale * (window.devicePixelRatio || 1),
			});
			const canvas = document.createElement("canvas");
			canvas.width = Math.floor(viewport.width);
			canvas.height = Math.floor(viewport.height);
			task = page.render({ canvas, viewport });
			await task.promise;
			if (cancelled) return;
			holder.current?.replaceChildren(canvas);
			rendered.current = { proxy, scale };
		})().catch(() => {});
		return () => {
			cancelled = true;
			task?.cancel();
		};
	}, [near, proxy, number, scale]);

	const inverse = (event: MouseEvent<HTMLDivElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		onInverse(
			number,
			(event.clientX - rect.left) / scale,
			(event.clientY - rect.top) / scale,
		);
	};

	// Pointing at a spot on a page has no keyboard equivalent; Show in PDF is
	// the keyboard route between the panes.
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: see above
		<div
			className="pdf-page"
			data-page={number}
			role="img"
			aria-label={`Page ${number}`}
			style={{ width: size.width * scale, height: size.height * scale }}
			onDoubleClick={inverse}
			onClick={(e) => {
				if (e.ctrlKey || e.metaKey) inverse(e);
			}}
		>
			<div ref={holder} className="pdf-canvas" />
			{flash && (
				<div
					key={flash.n}
					className="pdf-highlight"
					aria-hidden="true"
					style={{
						left: (flash.box.x - 2) * scale,
						top: (flash.box.y - 2) * scale,
						width: (Math.max(flash.box.width, 8) + 4) * scale,
						height: (flash.box.height + 4) * scale,
					}}
				/>
			)}
		</div>
	);
}
