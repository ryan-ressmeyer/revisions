// A readable view of a unified diff: one collapsible section per file, one
// table per hunk, additions and deletions coloured and marked up as ins/del.
import { Fragment, useMemo } from "react";
import { type DiffFile, type DiffHunk, parseDiff } from "../core/diff/diff";

const fileWords: Record<DiffFile["status"], string> = {
	modified: "changed",
	added: "new file",
	deleted: "deleted",
	renamed: "renamed",
};

// ponytail: a fixed cap per file keeps a huge diff from freezing the page;
// virtualise the rows if manuscripts ever need more on screen.
const MAX_LINES = 1500;

// Git's function-context text after the range means nothing for LaTeX.
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)/;

function hunkLabel(hunk: DiffHunk): string {
	const m = HUNK.exec(hunk.header);
	return m ? `Line ${m[1]}` : hunk.header;
}

/** Goes to a line of the file as it is now. */
type OnLine = (path: string, line: number) => void;

/** With `onLine`, a line or a hunk's heading leads to that line in the editor. */
export function DiffView({ diff, onLine }: { diff: string; onLine?: OnLine }) {
	const files = useMemo(() => parseDiff(diff), [diff]);
	if (files.length === 0) return <p className="muted">No changes to show.</p>;
	return (
		<div className="diff">
			{files.map((file, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole
				<DiffFileView key={i} file={file} onLine={onLine} />
			))}
		</div>
	);
}

function DiffFileView({ file, onLine }: { file: DiffFile; onLine?: OnLine }) {
	// A deleted file has no line to go to.
	const path = file.newPath;
	const jump =
		onLine && path ? (line: number) => onLine(path, line) : undefined;
	const name =
		file.status === "renamed"
			? `${file.oldPath} → ${file.newPath}`
			: (file.newPath ?? file.oldPath ?? "Unknown file");
	let added = 0;
	let deleted = 0;
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			if (line.kind === "add") added++;
			else if (line.kind === "delete") deleted++;
		}
	}
	let budget = MAX_LINES;
	let hidden = 0;
	const hunks = file.hunks.map((hunk) => {
		const lines = hunk.lines.slice(0, Math.max(0, budget));
		hidden += hunk.lines.length - lines.length;
		budget -= lines.length;
		return { hunk, lines };
	});

	return (
		<details open className="diff-file">
			<summary>
				<span className="diff-path">{name}</span>
				<span className="muted">{fileWords[file.status]}</span>
				<span className="diff-stat">
					<span className="plus" title={`${added} lines added`}>
						+{added}
					</span>{" "}
					<span className="minus" title={`${deleted} lines removed`}>
						−{deleted}
					</span>
				</span>
			</summary>
			{file.binary ? (
				<p className="diff-note muted">
					This file is not text, so its changes cannot be shown.
				</p>
			) : file.hunks.length === 0 ? (
				<p className="diff-note muted">
					{file.status === "renamed"
						? "The file was renamed; its text did not change."
						: "No text changed."}
				</p>
			) : (
				<table className={jump ? "diff-table jumps" : "diff-table"}>
					<colgroup>
						<col className="ln-col" />
						<col className="ln-col" />
						<col />
					</colgroup>
					<tbody>
						{hunks.map(({ hunk, lines }, i) => {
							const start = Number(HUNK.exec(hunk.header)?.[1] ?? 1);
							// A removed line leads to where it was: the line after the
							// last one the new file still has.
							let next = start;
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: hunks never reorder
								<Fragment key={i}>
									<tr className="diff-hunk">
										<td colSpan={3}>
											{jump ? (
												<button
													type="button"
													className="link"
													onClick={() => jump(start)}
													title="Go to this line in the editor"
												>
													{hunkLabel(hunk)}
												</button>
											) : (
												hunkLabel(hunk)
											)}
										</td>
									</tr>
									{lines.map((line, j) => {
										const at = line.newLine ?? next;
										if (line.newLine) next = line.newLine + 1;
										return (
											<tr
												// biome-ignore lint/suspicious/noArrayIndexKey: lines never reorder
												key={j}
												className={`diff-${line.kind}`}
												onClick={jump && (() => jump(at))}
												title={jump && "Go to this line in the editor"}
											>
												<td className="ln">{line.oldLine ?? ""}</td>
												<td className="ln">{line.newLine ?? ""}</td>
												<td className="code">
													{line.kind === "add" ? (
														<ins>{line.text}</ins>
													) : line.kind === "delete" ? (
														<del>{line.text}</del>
													) : (
														line.text
													)}
												</td>
											</tr>
										);
									})}
								</Fragment>
							);
						})}
						{hidden > 0 && (
							<tr className="diff-hunk">
								<td colSpan={3}>{hidden} more lines are not shown here.</td>
							</tr>
						)}
					</tbody>
				</table>
			)}
		</details>
	);
}
