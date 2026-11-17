// node e2e/race-summarize.mjs <RACE_WORK>/logs/results-natural.jsonl [results-widened.jsonl ...]
import { readFileSync } from "node:fs";

const rows = process.argv.slice(2).flatMap((f) =>
	readFileSync(f, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l)),
);
const groups = new Map();
for (const r of rows) {
	// commit-checkout: text saved before the commit is committed on main, not lost.
	if (
		r.typedTextCommittedOnMain &&
		["LOST", "EDITOR-ONLY", "OK-COLLISION"].includes(r.outcome)
	)
		r.outcome = `OK-COMMITTED(${r.outcome})`;
	const k = `${r.case} | ${r.regime}`;
	if (!groups.has(k)) groups.set(k, []);
	groups.get(k).push(r);
}
const stat = (xs) => {
	const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
	if (!v.length) return "-";
	return `${v[Math.floor(v.length / 2)]} [${v[0]}-${v.at(-1)}]`;
};
const count = (xs) => {
	const m = {};
	for (const x of xs) m[x] = (m[x] ?? 0) + 1;
	return Object.entries(m)
		.map(([k, n]) => `${k} ${n}`)
		.join(", ");
};
console.log(
	"| case | regime | n | outcomes | op refused | op ms med [min-max] | header change ms | lock change ms |",
);
console.log("|---|---|---|---|---|---|---|---|");
for (const [k, rs] of [...groups].sort()) {
	const [c, reg] = k.split(" | ");
	console.log(
		`| ${c} | ${reg} | ${rs.length} | ${count(rs.map((r) => r.outcome))} | ${count(rs.map((r) => r.opRefused).filter(Boolean)) || "-"} | ${stat(rs.map((r) => r.opMs))} | ${stat(rs.map((r) => r.headerChangeMs))} | ${stat(rs.map((r) => r.lockChangeMs))} |`,
	);
}
