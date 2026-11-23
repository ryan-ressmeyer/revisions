import { type FormEvent, useEffect, useState } from "react";
import {
	linkFolder,
	listRepos,
	openUrl,
	type RepoId,
	type RepoSummary,
} from "../api/client";
import { explain, isCode } from "./errors";
import { type Move, MovePrompt, runMove, Unclean } from "./Git";
import { RepoMenu } from "./RepoMenu";
import { repoHref } from "./route";

// ponytail: the UI reads owner and name from the link itself to offer the
// existing copy's move prompt after a `dirty` refusal. Ask the server to put `repo` in the
// error if hosts other than GitHub arrive.
function repoOfUrl(url: string): RepoId | null {
	const match = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/.exec(
		url,
	);
	return match ? `github.com/${match[1]}/${match[2]}` : null;
}

/** A failed Open; `repo` is the existing copy to offer as it is. */
type Failure = { message: string; repo: RepoId | null };

export function Home({
	onGitMissing,
	onSignedOut,
}: {
	onGitMissing: () => void;
	onSignedOut: () => void;
}) {
	const [url, setUrl] = useState("");
	const [folder, setFolder] = useState("");
	const [opening, setOpening] = useState(false);
	const [linking, setLinking] = useState(false);
	const busy = opening || linking;
	const [failure, setFailure] = useState<Failure | null>(null);
	const [repos, setRepos] = useState<RepoSummary[] | null>(null);
	const [prompt, setPrompt] = useState<{
		repo: RepoId;
		unclean: Unclean;
	} | null>(null);

	useEffect(() => {
		listRepos().then(setRepos, () => setRepos([]));
	}, []);

	const open = async (event: FormEvent) => {
		event.preventDefault();
		setFailure(null);
		setOpening(true);
		const link = url.trim();
		const repo = repoOfUrl(link);
		const move: Move = {
			label: `Open ${link}`,
			run: async () => {
				window.location.hash = repoHref((await openUrl(link)).repo);
			},
		};
		try {
			await (repo ? runMove(repo, move) : move.run());
		} catch (error) {
			setOpening(false);
			if (error instanceof Unclean && repo)
				return setPrompt({ repo, unclean: error });
			if (isCode(error, "git_missing")) return onGitMissing();
			if (isCode(error, "auth_required")) onSignedOut();
			setFailure({
				message: explain(error),
				repo: isCode(error, "merging") ? repo : null,
			});
		}
	};
	const link = async (event: FormEvent) => {
		event.preventDefault();
		setFailure(null);
		setLinking(true);
		try {
			window.location.hash = repoHref((await linkFolder(folder)).repo);
		} catch (error) {
			setLinking(false);
			if (isCode(error, "git_missing")) return onGitMissing();
			setFailure({ message: explain(error), repo: null });
		}
	};
	const openAsItIs = (repo: RepoId) => (
		<button
			type="button"
			onClick={() => {
				window.location.hash = repoHref(repo);
			}}
		>
			Open this copy as it is
		</button>
	);

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
						disabled={busy}
						required
					/>
					<button type="submit" className="primary" disabled={busy}>
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
				<p className="muted link-intro">
					Or use a Git repository you already keep somewhere on this computer.
					Its origin must be the repository on GitHub.
				</p>
				<form onSubmit={link} className="open-form link-form">
					<label htmlFor="folder" className="visually-hidden">
						Folder on this computer
					</label>
					<input
						id="folder"
						type="text"
						autoComplete="off"
						spellCheck={false}
						placeholder="/Users/you/papers/manuscript"
						value={folder}
						onChange={(e) => setFolder(e.target.value)}
						disabled={busy}
						required
					/>
					<button type="submit" disabled={busy}>
						Link
					</button>
				</form>
				{failure && (
					<div role="alert" className="alert">
						<p>{failure.message}</p>
						{failure.repo && openAsItIs(failure.repo)}
					</div>
				)}
				{prompt && (
					<MovePrompt
						id={prompt.repo}
						unclean={prompt.unclean}
						onAuthLost={onSignedOut}
						onMoved={() => setPrompt(null)}
						onClose={() => setPrompt(null)}
					>
						{openAsItIs(prompt.repo)}
					</MovePrompt>
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
								<span>
									<a href={repoHref(r.id)}>
										{r.id.split("/").slice(1).join("/")}
									</a>
									<span className="muted repo-path">{r.path}</span>
								</span>
								<span className="muted repo-branch">
									{r.branch
										? `branch ${r.branch}`
										: `version ${r.head.slice(0, 7)}`}
								</span>
								<RepoMenu
									repo={r}
									onAuthLost={onSignedOut}
									onRemoved={() => listRepos().then(setRepos, () => {})}
								/>
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	);
}
