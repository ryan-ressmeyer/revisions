import { type FormEvent, useEffect, useState } from "react";
import {
	ApiError,
	listRepos,
	openUrl,
	type RepoId,
	type RepoSummary,
} from "../api/client";
import type { FileStatus } from "../api/git";
import { explain, isCode } from "./errors";
import { statusWords } from "./Git";
import { repoHref } from "./route";

// ponytail: the UI reads owner and name from the link itself to offer the
// existing copy after a `dirty` refusal. Ask the server to put `repo` in the
// error if hosts other than GitHub arrive.
function repoOfUrl(url: string): RepoId | null {
	const match = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/.exec(
		url,
	);
	return match ? `github.com/${match[1]}/${match[2]}` : null;
}

type Failure =
	| { kind: "dirty"; files: FileStatus[]; repo: RepoId | null }
	| { kind: "message"; message: string };

export function Home({
	onGitMissing,
	onSignedOut,
}: {
	onGitMissing: () => void;
	onSignedOut: () => void;
}) {
	const [url, setUrl] = useState("");
	const [opening, setOpening] = useState(false);
	const [failure, setFailure] = useState<Failure | null>(null);
	const [repos, setRepos] = useState<RepoSummary[] | null>(null);

	useEffect(() => {
		listRepos().then(setRepos, () => setRepos([]));
	}, []);

	const open = async (event: FormEvent) => {
		event.preventDefault();
		setFailure(null);
		setOpening(true);
		try {
			const opened = await openUrl(url.trim());
			window.location.hash = repoHref(opened.repo);
		} catch (error) {
			setOpening(false);
			if (isCode(error, "git_missing")) return onGitMissing();
			if (isCode(error, "auth_required")) return onSignedOut();
			if (error instanceof ApiError && error.code === "dirty") {
				setFailure({
					kind: "dirty",
					files: (error.extra.files as FileStatus[] | undefined) ?? [],
					repo: repoOfUrl(url),
				});
			} else {
				setFailure({ kind: "message", message: explain(error) });
			}
		}
	};

	return (
		<main className="home">
			<section className="card open-box">
				<h1>Open a manuscript</h1>
				<p className="muted">
					Paste the GitHub link your co-author sent you. It can point to the
					repository, a branch, a commit, or a pull request.
				</p>
				<form onSubmit={open} className="open-form">
					<label htmlFor="url" className="visually-hidden">
						GitHub link
					</label>
					<input
						id="url"
						type="text"
						inputMode="url"
						autoComplete="off"
						spellCheck={false}
						placeholder="https://github.com/…"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						disabled={opening}
						required
					/>
					<button type="submit" className="primary" disabled={opening}>
						Open
					</button>
				</form>
				<p className="muted opening" aria-live="polite">
					{opening && (
						<>
							<span className="spinner" aria-hidden="true" /> Getting the
							manuscript from GitHub. The first time can take a minute.
						</>
					)}
				</p>
				{failure?.kind === "message" && (
					<div role="alert" className="alert">
						{failure.message}
					</div>
				)}
				{failure?.kind === "dirty" && (
					<div role="alert" className="alert">
						<p>
							The copy of this manuscript on this computer has changes that are
							not yet saved to Git, so Revisions did not switch it to the link
							you opened. Nothing was changed. To switch, commit them or discard
							them first.
						</p>
						<p>Files with changes:</p>
						<ul>
							{failure.files.map((f) => (
								<li key={f.path}>
									{f.path} ({statusWords[f.status]})
								</li>
							))}
						</ul>
						{failure.repo && (
							<button
								type="button"
								onClick={() => {
									window.location.hash = repoHref(failure.repo ?? "");
								}}
							>
								Open this copy as it is
							</button>
						)}
					</div>
				)}
			</section>

			<section className="recent" aria-labelledby="recent-heading">
				<h2 id="recent-heading">On this computer</h2>
				{repos === null ? null : repos.length === 0 ? (
					<p className="muted">Manuscripts you open appear here.</p>
				) : (
					<ul className="repo-list">
						{repos.map((r) => (
							<li key={r.id}>
								<a href={repoHref(r.id)}>
									{r.id.split("/").slice(1).join("/")}
								</a>
								<span className="muted">
									{r.branch
										? `branch ${r.branch}`
										: `version ${r.head.slice(0, 7)}`}
								</span>
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	);
}
