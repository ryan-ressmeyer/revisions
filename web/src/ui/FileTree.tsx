// The repository's files as a tree in a sidebar, with the WAI-ARIA tree
// keyboard pattern: arrows move, Right and Left open and close folders,
// Home and End jump, Enter and Space open.
import {
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { RepoId } from "../api/client";
import type { ProjectFile } from "../api/repo";

interface Folder {
	path: string;
	name: string;
	folders: Folder[];
	files: ProjectFile[];
}

/** The files as nested folders, folders first, each level sorted by name. */
function build(files: readonly ProjectFile[]): Folder {
	const root: Folder = { path: "", name: "", folders: [], files: [] };
	for (const f of files) {
		const parts = f.path.split("/");
		let at = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const path = parts.slice(0, i + 1).join("/");
			let next = at.folders.find((d) => d.path === path);
			if (!next) {
				next = { path, name: parts[i] ?? "", folders: [], files: [] };
				at.folders.push(next);
			}
			at = next;
		}
		at.files.push(f);
	}
	const sort = (d: Folder) => {
		d.folders.sort((a, b) => a.name.localeCompare(b.name));
		d.files.sort((a, b) => a.path.localeCompare(b.path));
		d.folders.forEach(sort);
	};
	sort(root);
	return root;
}

interface Row {
	path: string;
	name: string;
	level: number;
	parent: string;
	folder: boolean;
	file?: ProjectFile;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The rows on screen: every item whose ancestors are all expanded. */
function visibleRows(root: Folder, expanded: ReadonlySet<string>): Row[] {
	const rows: Row[] = [];
	const walk = (d: Folder, level: number) => {
		for (const f of d.folders) {
			rows.push({
				path: f.path,
				name: f.name,
				level,
				parent: d.path,
				folder: true,
			});
			if (expanded.has(f.path)) walk(f, level + 1);
		}
		for (const f of d.files) {
			rows.push({
				path: f.path,
				name: baseName(f.path),
				level,
				parent: d.path,
				folder: false,
				file: f,
			});
		}
	};
	walk(root, 1);
	return rows;
}

const ancestors = (path: string) => {
	const parts = path.split("/");
	return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

/** Expanded folders are a per-viewer convenience, kept per repository. */
function useExpanded(id: RepoId, initial: () => string[]) {
	const key = `revisions.tree.${id}`;
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
		try {
			const saved = localStorage.getItem(key);
			if (saved) return new Set(JSON.parse(saved) as string[]);
		} catch {
			// Fall back to the folders of the main document.
		}
		return new Set(initial());
	});
	useEffect(() => {
		try {
			localStorage.setItem(key, JSON.stringify([...expanded]));
		} catch {
			// Storage is a convenience; the tree works without it.
		}
	}, [key, expanded]);
	return [expanded, setExpanded] as const;
}

export function FileTree({
	id,
	files,
	entry,
	current,
	onOpen,
}: {
	id: RepoId;
	files: readonly ProjectFile[];
	/** The main document, which gets a mark. */
	entry: string;
	/** The file shown in the editor pane, highlighted. */
	current: string;
	onOpen: (file: ProjectFile) => void;
}) {
	const root = useMemo(() => build(files), [files]);
	const [expanded, setExpanded] = useExpanded(id, () => ancestors(entry));
	const rows = useMemo(() => visibleRows(root, expanded), [root, expanded]);
	const [focused, setFocused] = useState(current);
	const list = useRef<HTMLDivElement>(null);

	// Keep the open file reachable: its folders open when it changes.
	useEffect(() => {
		const up = ancestors(current);
		setExpanded((e) =>
			up.every((p) => e.has(p)) ? e : new Set([...e, ...up]),
		);
		setFocused(current);
	}, [current, setExpanded]);

	const tabStop = rows.some((r) => r.path === focused)
		? focused
		: (rows[0]?.path ?? "");
	const move = (path: string | undefined) => {
		if (!path) return;
		setFocused(path);
		list.current
			?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
			?.focus();
	};
	const toggle = (path: string, open: boolean) =>
		setExpanded((e) => {
			const next = new Set(e);
			if (open) next.add(path);
			else next.delete(path);
			return next;
		});
	const activate = (row: Row) => {
		if (row.folder) toggle(row.path, !expanded.has(row.path));
		else if (row.file) onOpen(row.file);
	};

	const key = (event: KeyboardEvent, row: Row) => {
		const i = rows.indexOf(row);
		const handled = () => {
			event.preventDefault();
			event.stopPropagation();
		};
		switch (event.key) {
			case "ArrowDown":
				handled();
				move(rows[i + 1]?.path);
				break;
			case "ArrowUp":
				handled();
				move(rows[i - 1]?.path);
				break;
			case "Home":
				handled();
				move(rows[0]?.path);
				break;
			case "End":
				handled();
				move(rows.at(-1)?.path);
				break;
			case "ArrowRight":
				handled();
				if (row.folder && !expanded.has(row.path)) toggle(row.path, true);
				else if (row.folder) move(rows[i + 1]?.path);
				break;
			case "ArrowLeft":
				handled();
				if (row.folder && expanded.has(row.path)) toggle(row.path, false);
				else move(row.parent || undefined);
				break;
			case "Enter":
			case " ":
				handled();
				activate(row);
				break;
		}
	};

	return (
		<nav className="file-tree" aria-label="Repository files">
			<div ref={list} role="tree" aria-label="Files">
				{rows.map((row) => (
					<div
						key={row.path}
						role="treeitem"
						data-path={row.path}
						aria-level={row.level}
						aria-expanded={row.folder ? expanded.has(row.path) : undefined}
						aria-selected={row.folder ? undefined : row.path === current}
						tabIndex={row.path === tabStop ? 0 : -1}
						className={`tree-row ${row.folder ? "folder" : `file ${row.file?.kind}`}`}
						style={{ paddingLeft: `${0.5 + (row.level - 1) * 0.9}rem` }}
						onClick={() => {
							setFocused(row.path);
							activate(row);
						}}
						onKeyDown={(e) => key(e, row)}
						title={row.path}
					>
						<span className="tree-icon" aria-hidden="true">
							{row.folder ? (expanded.has(row.path) ? "▾" : "▸") : ""}
						</span>
						<span className="tree-name">{row.name}</span>
						{row.path === entry && (
							<span className="tree-main" title="The main document">
								main<span className="visually-hidden"> document</span>
							</span>
						)}
					</div>
				))}
			</div>
		</nav>
	);
}
