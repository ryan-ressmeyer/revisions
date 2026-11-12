// Branch labels for the commit graph, from the full ref names of
// `GET R/git/log`.

const LOCAL = "refs/heads/";
const REMOTES = "refs/remotes/";
const ORIGIN = `${REMOTES}origin/`;

/** One branch label on a commit. */
export interface RefChip {
	/** The branch name; a remote other than origin keeps its prefix. */
	name: string;
	/**
	 * `both` when the branch on this computer and origin's copy of it sit on
	 * this commit, so they are in sync.
	 */
	where: "local" | "remote" | "both";
	/** True for the checked-out branch. */
	current: boolean;
}

/**
 * The chips of one commit, the checked-out branch first and the rest by
 * name. `detached` is true when HEAD is here without a branch.
 */
export function refChips(
	refs: readonly string[],
	branch: string | null,
): { chips: RefChip[]; detached: boolean } {
	const chips = new Map<string, RefChip>();
	for (const ref of refs) {
		if (ref.startsWith(LOCAL)) {
			const name = ref.slice(LOCAL.length);
			chips.set(name, { name, where: "local", current: name === branch });
		}
	}
	for (const ref of refs) {
		if (!ref.startsWith(REMOTES)) continue;
		const name = ref.startsWith(ORIGIN)
			? ref.slice(ORIGIN.length)
			: ref.slice(REMOTES.length);
		const local = ref.startsWith(ORIGIN) ? chips.get(name) : undefined;
		if (local) local.where = "both";
		else chips.set(`remote:${name}`, { name, where: "remote", current: false });
	}
	const sorted = [...chips.values()].sort(
		(a, b) =>
			Number(b.current) - Number(a.current) || a.name.localeCompare(b.name),
	);
	return { chips: sorted, detached: branch === null && refs.includes("HEAD") };
}

/** A branch the user can switch to. */
export interface BranchChoice {
	name: string;
	/** On this computer. */
	local: boolean;
	/** On GitHub, as `origin/<name>`. */
	remote: boolean;
}

/**
 * Every local branch and every branch of origin named in `commits`, by name.
 * Other remotes are left out: switching only knows origin.
 */
// ponytail: derived from the log, so a branch whose tip is older than the
// log limit is missing. Add a branch-list route if that ever matters.
export function branchChoices(
	commits: readonly { refs: readonly string[] }[],
): BranchChoice[] {
	const found = new Map<string, BranchChoice>();
	const get = (name: string) => {
		const choice = found.get(name) ?? { name, local: false, remote: false };
		found.set(name, choice);
		return choice;
	};
	for (const { refs } of commits) {
		for (const ref of refs) {
			if (ref.startsWith(LOCAL)) get(ref.slice(LOCAL.length)).local = true;
			else if (ref.startsWith(ORIGIN))
				get(ref.slice(ORIGIN.length)).remote = true;
		}
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
