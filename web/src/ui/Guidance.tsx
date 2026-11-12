import { type ReactNode, useState } from "react";
import type { Platform } from "../api/client";

function Link({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a href={href} target="_blank" rel="noreferrer">
			{children}
		</a>
	);
}

function CheckAgain({ onCheck }: { onCheck: () => Promise<unknown> }) {
	const [checking, setChecking] = useState(false);
	const [notYet, setNotYet] = useState(false);
	const check = async () => {
		setChecking(true);
		setNotYet(false);
		await onCheck().catch(() => {});
		setChecking(false);
		setNotYet(true);
	};
	return (
		<div className="row">
			<button
				type="button"
				className="primary"
				onClick={check}
				disabled={checking}
			>
				{checking ? "Checking…" : "Check again"}
			</button>
			<span className="muted" aria-live="polite">
				{notYet && !checking
					? "Still not found. Finish the install, then check again."
					: ""}
			</span>
		</div>
	);
}

const gitSteps: Record<Platform, ReactNode> = {
	darwin: (
		<ol>
			<li>
				Open the <b>Terminal</b> app. It is in Applications, in the Utilities
				folder.
			</li>
			<li>
				Type <code>git --version</code> and press Return.
			</li>
			<li>
				macOS offers to install the <b>Command Line Tools</b>, which include
				Git. Click <b>Install</b> and wait until it finishes. (If nothing
				appears, type <code>xcode-select --install</code> instead.)
			</li>
		</ol>
	),
	windows: (
		<ol>
			<li>
				Download Git for Windows from{" "}
				<Link href="https://git-scm.com/download/win">
					git-scm.com/download/win
				</Link>
				.
			</li>
			<li>Run the installer and keep the choices it suggests.</li>
		</ol>
	),
	linux: (
		<ol>
			<li>
				Install Git with your package manager, for example{" "}
				<code>sudo apt install git</code> on Ubuntu or Debian, or{" "}
				<code>sudo dnf install git</code> on Fedora.
			</li>
			<li>
				Other systems are listed at{" "}
				<Link href="https://git-scm.com/download/linux">
					git-scm.com/download/linux
				</Link>
				.
			</li>
		</ol>
	),
};

/** Shown instead of everything else while Git is missing. */
export function GitGuidance({
	platform,
	onCheck,
}: {
	platform: Platform;
	onCheck: () => Promise<unknown>;
}) {
	return (
		<main className="center">
			<section className="card guidance">
				<h1>Install Git to continue</h1>
				<p>
					Revisions uses Git, a free program, to bring the manuscript to this
					computer and to keep track of changes. Git is not installed yet.
				</p>
				{gitSteps[platform]}
				<p>When the install has finished, come back here.</p>
				<CheckAgain onCheck={onCheck} />
			</section>
		</main>
	);
}

const tex = {
	mactex: <Link href="https://tug.org/mactex/">MacTeX (tug.org/mactex)</Link>,
	miktex: (
		<Link href="https://miktex.org/download">MiKTeX (miktex.org/download)</Link>
	),
	texlive: (
		<Link href="https://tug.org/texlive/">TeX Live (tug.org/texlive)</Link>
	),
};

const texSteps: Record<Platform, ReactNode> = {
	darwin: (
		<ol>
			<li>
				Download {tex.mactex}. It is a large download of several gigabytes.
			</li>
			<li>Open the downloaded package and follow the installer.</li>
		</ol>
	),
	windows: (
		<ol>
			<li>Download {tex.miktex} and run the installer.</li>
			<li>Let MiKTeX install missing packages on the fly when it asks.</li>
		</ol>
	),
	linux: (
		<ol>
			<li>
				Install {tex.texlive} with your package manager, for example{" "}
				<code>sudo apt install texlive-full latexmk</code> on Ubuntu or Debian.
			</li>
			<li>Or use the installer from the TeX Live site.</li>
		</ol>
	),
};

/** Shown in the PDF pane instead of building while LaTeX is missing. */
export function TexGuidance({
	platform,
	onCheck,
}: {
	platform: Platform;
	onCheck: () => Promise<unknown>;
}) {
	return (
		<section className="card guidance">
			<h2>Install LaTeX to build the PDF</h2>
			<p>
				Revisions turns the manuscript into a PDF with LaTeX, a free typesetting
				system. LaTeX is not installed on this computer yet. You can keep
				editing while it installs.
			</p>
			{texSteps[platform]}
			<CheckAgain onCheck={onCheck} />
		</section>
	);
}
