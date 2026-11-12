// Commit-graph layout. Turns a commit list into lanes and row-to-row line
// segments that a UI can draw without knowing anything about Git.

/** One commit of `GET R/git/log`. Extra fields are ignored. */
export interface GraphCommit {
	sha: string;
	/** Parent shas, first parent first. A parent may be missing from the log. */
	parents: readonly string[];
}

/**
 * A line segment from lane `from` on one row to lane `to` on the row below.
 * Draw it straight when the lanes are equal and as a curve otherwise.
 */
export interface GraphEdge {
	from: number;
	to: number;
	/** Colour index of the branch line the segment belongs to. */
	color: number;
}

/** One row of the graph, in the order of the input. */
export interface GraphRow {
	/** The commit's sha, or null for the uncommitted-changes row. */
	sha: string | null;
	/** The column of the commit's dot, counted from 0 on the left. */
	lane: number;
	/**
	 * Colour index of the dot. Indices count up from 0 with no upper bound;
	 * take them modulo the palette size. A lane keeps its index from the
	 * commit that opens it to the commit that ends it.
	 */
	color: number;
	/**
	 * Segments between this row and the next. On the last row they point at
	 * a row that is not in the log: those lines lead to parents that the log
	 * limit cut off.
	 */
	edges: GraphEdge[];
}

export interface GraphLayout {
	rows: GraphRow[];
	/** The number of lanes the graph needs. */
	width: number;
}

export interface GraphOptions {
	/**
	 * The sha of HEAD. When given, the first row is a synthetic
	 * uncommitted-changes row (`sha: null`) joined to that commit.
	 */
	uncommittedOn?: string;
}

/**
 * Lays out commits given in `git log --date-order` order, children before
 * parents. A commit takes the leftmost lane that leads to it, or the leftmost
 * free lane when it is a branch tip. Its first parent continues the lane and
 * each further parent joins the lane that already leads to it or opens a new
 * one.
 */
export function layoutGraph(
	commits: readonly GraphCommit[],
	options: GraphOptions = {},
): GraphLayout {
	const input: { sha: string | null; parents: readonly string[] }[] =
		options.uncommittedOn === undefined
			? [...commits]
			: [{ sha: null, parents: [options.uncommittedOn] }, ...commits];

	// Each open lane is a line running down to the commit it awaits.
	const lanes: ({ awaits: string; color: number } | null)[] = [];
	let colorCount = 0;
	const find = (sha: string | null | undefined) =>
		lanes.findIndex((lane) => lane !== null && lane.awaits === sha);
	const open = (awaits: string) => {
		const free = lanes.indexOf(null);
		const index = free < 0 ? lanes.length : free;
		lanes[index] = { awaits, color: colorCount++ };
		return index;
	};

	const rows = input.map((commit, i): GraphRow => {
		const found = find(commit.sha);
		const lane = found < 0 ? open("") : found;
		const color = lanes[lane]?.color ?? 0;
		// Every line that led here ends at this commit.
		lanes[lane] = null;
		for (let j = 0; j < lanes.length; j++) {
			if (lanes[j]?.awaits === commit.sha) lanes[j] = null;
		}
		const passing = lanes.map((other) => other !== null);

		const leaving = new Set<number>();
		[...new Set(commit.parents)].forEach((parent, k) => {
			if (k === 0) {
				lanes[lane] = { awaits: parent, color };
				leaving.add(lane);
				return;
			}
			const existing = find(parent);
			leaving.add(existing < 0 ? open(parent) : existing);
		});

		// Lines that await the next commit bend into its lane.
		const next = input[i + 1]?.sha;
		const nextLane = find(next);
		const edges: GraphEdge[] = [];
		lanes.forEach((line, j) => {
			if (line === null) return;
			const to = line.awaits === next ? nextLane : j;
			if (passing[j]) edges.push({ from: j, to, color: line.color });
			if (leaving.has(j)) edges.push({ from: lane, to, color: line.color });
		});
		return { sha: commit.sha, lane, color, edges };
	});
	return { rows, width: lanes.length };
}
