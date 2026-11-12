import { expect, test } from "vitest";
import { fixture } from "../latex/fixture";
import { bibEntries } from "./bib";

test("the fixture bibliography lists its three entries", () => {
	const text = fixture("refs.bib");
	const entries = bibEntries(text);
	expect(entries.map((e) => [e.type, e.key])).toEqual([
		["article", "rolfs2009"],
		["article", "rucci2015"],
		["article", "engbert2003"],
	]);
	const first = entries[0];
	expect(first && text.slice(first.from, first.to)).toBe("@article{rolfs2009");
});

test("extraction tolerates odd layout and skips non-entries", () => {
	const text = [
		'@string{jvr = "Vision Research"}',
		'@preamble{ "\\newcommand{\\noop}[1]{}" }',
		"@comment{ @article{hidden, title = {x} } }",
		"% @article{commented,",
		"@Book ( paren:key ,",
		"  title = {A @misc{inner, title} },",
		")",
		"@InProceedings{ spaced-key_1 , author = {A}}",
		"stray text @ nothing",
		"@article{halftyped",
	].join("\n");
	expect(bibEntries(text).map((e) => [e.type, e.key])).toEqual([
		["book", "paren:key"],
		["inproceedings", "spaced-key_1"],
	]);
});

test("junk input yields no entries and does not throw", () => {
	expect(bibEntries("")).toEqual([]);
	expect(bibEntries("@@@{{{,,,@comment{{{")).toEqual([]);
});
