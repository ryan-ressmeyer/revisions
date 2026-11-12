import { expect, test } from "vitest";
import { type GraphCommit, layoutGraph } from "./graph";

/** Builds a history from lines like `"C: A B"` (sha, then its parents). */
function history(...lines: string[]): GraphCommit[] {
	return lines.map((line) => {
		const [sha = "", parents = ""] = line.split(":");
		return { sha: sha.trim(), parents: parents.split(" ").filter(Boolean) };
	});
}

const lanes = (commits: GraphCommit[]) =>
	layoutGraph(commits).rows.map((row) => row.lane);
const colors = (commits: GraphCommit[]) =>
	layoutGraph(commits).rows.map((row) => row.color);
const edges = (commits: GraphCommit[]) =>
	layoutGraph(commits).rows.map((row) =>
		row.edges.map((edge) => `${edge.from}>${edge.to}`).join(" "),
	);

test("linear history stays in one lane", () => {
	const commits = history("C: B", "B: A", "A:");
	expect(layoutGraph(commits)).toEqual({
		width: 1,
		rows: [
			{ sha: "C", lane: 0, color: 0, edges: [{ from: 0, to: 0, color: 0 }] },
			{ sha: "B", lane: 0, color: 0, edges: [{ from: 0, to: 0, color: 0 }] },
			{ sha: "A", lane: 0, color: 0, edges: [] },
		],
	});
});

test("two branch tips run side by side and join at their fork point", () => {
	// F and M both sit on B.
	const commits = history("F: B", "M: B", "B: A", "A:");
	expect(lanes(commits)).toEqual([0, 1, 0, 0]);
	expect(colors(commits)).toEqual([0, 1, 0, 0]);
	expect(layoutGraph(commits).rows[1]?.edges).toEqual([
		{ from: 0, to: 0, color: 0 },
		{ from: 1, to: 0, color: 1 },
	]);
	expect(layoutGraph(commits).width).toBe(2);
});

test("a merge opens a lane for its second parent", () => {
	// M merges F into the main line A2; both descend from A1.
	const commits = history("M: A2 F", "F: A1", "A2: A1", "A1:");
	expect(lanes(commits)).toEqual([0, 1, 0, 0]);
	expect(colors(commits)).toEqual([0, 1, 0, 0]);
	expect(edges(commits)).toEqual(["0>0 0>1", "0>0 1>1", "0>0 1>0", ""]);
	// The merge connector takes the colour of the merged branch.
	expect(layoutGraph(commits).rows[0]?.edges[1]?.color).toBe(1);
});

test("a merge joins a lane that already leads to its second parent", () => {
	// T is a tip on F; M then merges F.
	const commits = history("T: F", "M: A F", "F: A", "A:");
	expect(lanes(commits)).toEqual([0, 1, 0, 0]);
	expect(edges(commits)).toEqual(["0>0", "0>0 1>0 1>1", "0>0 1>0", ""]);
	expect(layoutGraph(commits).width).toBe(2);
});

test("an octopus merge fans out to every parent", () => {
	const commits = history("M: A B C", "A: R", "B: R", "C: R", "R:");
	expect(lanes(commits)).toEqual([0, 0, 1, 2, 0]);
	expect(edges(commits)).toEqual([
		"0>0 0>1 0>2",
		"0>0 1>1 2>2",
		"0>0 1>1 2>2",
		"0>0 1>0 2>0",
		"",
	]);
	expect(layoutGraph(commits).width).toBe(3);
});

test("separate roots end their lanes and get their own colours", () => {
	const commits = history("X2: X1", "X1:", "Y2: Y1", "Y1:");
	expect(lanes(commits)).toEqual([0, 0, 0, 0]);
	expect(colors(commits)).toEqual([0, 0, 1, 1]);
	expect(edges(commits)).toEqual(["0>0", "", "0>0", ""]);
});

test("a freed lane is reused by the next branch, with a new colour", () => {
	const commits = history("M: A F", "F: A", "A: R", "G: R", "R:");
	expect(lanes(commits)).toEqual([0, 1, 0, 1, 0]);
	expect(colors(commits)).toEqual([0, 1, 0, 2, 0]);
	expect(layoutGraph(commits).width).toBe(2);
});

test("a parent outside the window keeps its line running off the bottom", () => {
	// A and X were cut off by the log limit.
	const commits = history("M: B X", "B: A");
	expect(lanes(commits)).toEqual([0, 0]);
	expect(edges(commits)).toEqual(["0>0 0>1", "0>0 1>1"]);
});

test("the uncommitted-changes row sits on top of HEAD", () => {
	// HEAD is H, which is not the newest commit in the log.
	const commits = history("T: B", "H: B", "B:");
	const { rows } = layoutGraph(commits, { uncommittedOn: "H" });
	expect(rows.map((row) => row.sha)).toEqual([null, "T", "H", "B"]);
	expect(rows.map((row) => row.lane)).toEqual([0, 1, 0, 0]);
	expect(rows[0]?.edges).toEqual([{ from: 0, to: 0, color: 0 }]);
	expect(rows[2]?.color).toBe(0);
});

test("an empty log gives an empty graph", () => {
	expect(layoutGraph([])).toEqual({ rows: [], width: 0 });
});

/** Deterministic pseudo-random numbers in [0, 1). */
function mulberry32(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A random history, children before parents, with some parents cut off. */
function randomHistory(random: () => number): GraphCommit[] {
	const count = 1 + Math.floor(random() * 40);
	return Array.from({ length: count }, (_, i) => {
		const parents = new Set<string>();
		const wanted = [0, 1, 1, 1, 1, 2, 2, 3][Math.floor(random() * 8)] ?? 1;
		for (let k = 0; k < wanted; k++) {
			const parent = i + 1 + Math.floor(random() * 6);
			parents.add(parent < count ? `c${parent}` : `gone${parent}`);
		}
		return { sha: `c${i}`, parents: [...parents] };
	});
}

test("in random histories every line leads from a commit to one of its parents", () => {
	const random = mulberry32(20261110);
	for (let run = 0; run < 300; run++) {
		const commits = randomHistory(random);
		const { rows, width } = layoutGraph(commits);
		const inWindow = new Set(commits.map((commit) => commit.sha));
		expect(rows.map((row) => row.sha)).toEqual(commits.map((c) => c.sha));

		rows.forEach((row, r) => {
			const entering = new Set(rows[r - 1]?.edges.map((edge) => edge.to));
			// No line starts or stops in mid-air.
			for (const edge of row.edges) {
				expect(edge.from === row.lane || entering.has(edge.from)).toBe(true);
				expect(Math.max(row.lane, edge.from, edge.to)).toBeLessThan(width);
			}
			for (const lane of entering) {
				const continues = row.edges.some((edge) => edge.from === lane);
				expect(lane === row.lane || continues).toBe(true);
			}

			// Follow the lines down from this commit to the first commit each
			// one meets. A line through another commit's lane on that commit's
			// row would count as meeting it.
			const reached = new Set<string | null>();
			let runsOffBottom = false;
			let frontier = new Set([row.lane]);
			for (let k = r; frontier.size > 0; k++) {
				const next = new Set<number>();
				for (const edge of rows[k]?.edges ?? []) {
					if (frontier.has(edge.from)) next.add(edge.to);
				}
				const below = rows[k + 1];
				if (!below) {
					runsOffBottom = next.size > 0;
					break;
				}
				if (next.delete(below.lane)) reached.add(below.sha);
				frontier = next;
			}
			const parents = commits[r]?.parents ?? [];
			expect(reached).toEqual(new Set(parents.filter((p) => inWindow.has(p))));
			expect(runsOffBottom).toBe(parents.some((p) => !inWindow.has(p)));
		});
	}
});
