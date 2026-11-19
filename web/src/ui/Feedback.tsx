import { Component, type ReactNode, useState } from "react";
import { type Kind, noteProblem, reportUrl } from "./feedback";

const kinds: [Kind, string][] = [
	["bug", "Something doesn't work"],
	["idea", "I have an idea"],
	["confusing", "Something was confusing"],
];

/** The top-bar button that opens GitHub's issue forms. */
export function FeedbackButton() {
	const [open, setOpen] = useState(false);
	return (
		<span className="feedback">
			<button
				type="button"
				className="quiet"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				Feedback
			</button>
			{open && (
				// Links are built when the menu opens, so a problem report carries the latest failure.
				<nav className="popover feedback-menu" aria-label="Feedback">
					{kinds.map(([kind, label]) => (
						<a
							key={kind}
							href={reportUrl(kind)}
							target="_blank"
							rel="noreferrer"
							onClick={() => setOpen(false)}
						>
							{label}
						</a>
					))}
					<p className="help">
						Opens a form on GitHub. Issues there are public, so check what it
						says before you submit.
					</p>
				</nav>
			)}
		</span>
	);
}

/** Replaces a page that failed to draw with a way to report it and reload. */
export class ErrorBoundary extends Component<
	{ children: ReactNode },
	{ crashed: boolean }
> {
	override state = { crashed: false };

	static getDerivedStateFromError(error: unknown) {
		noteProblem(error);
		return { crashed: true };
	}

	override render() {
		if (!this.state.crashed) return this.props.children;
		return (
			<main className="center">
				<section className="card">
					<h1>Something went wrong</h1>
					<p>
						Revisions could not draw this page. Changes it already saved are
						safe on this computer. Reloading the page usually brings it back.
					</p>
					<div className="row end">
						<a href={reportUrl("bug")} target="_blank" rel="noreferrer">
							Report this problem
						</a>
						<button
							type="button"
							className="primary"
							onClick={() => window.location.reload()}
						>
							Reload
						</button>
					</div>
				</section>
			</main>
		);
	}
}
