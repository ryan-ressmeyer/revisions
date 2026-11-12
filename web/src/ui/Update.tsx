import { useState } from "react";
import type { Platform, UpdateInfo } from "../api/client";

/** A version as people read it: the tag v0.2.0 is version 0.2.0. */
export const shown = (version: string) => version.replace(/^v/, "");

/** "Version X is available", with Update and the release notes. */
export function UpdateNotice({
	update,
	onUpdate,
}: {
	update: UpdateInfo;
	/** Saves pending edits and starts the update; resolves with a reason when it would not. */
	onUpdate: () => Promise<string>;
}) {
	const [busy, setBusy] = useState(false);
	const [why, setWhy] = useState("");
	if (!update.available) return null;
	const start = async () => {
		setWhy("");
		setBusy(true);
		setWhy(await onUpdate());
		setBusy(false);
	};
	return (
		<section className="banner update" aria-label="Update available">
			<span>
				Version {shown(update.available)} is available.{" "}
				<a href={update.notesUrl} target="_blank" rel="noreferrer">
					Release notes
				</a>
			</span>
			<button type="button" onClick={start} disabled={busy}>
				Update
			</button>
			{why && (
				<p role="alert" className="alert">
					{why}
				</p>
			)}
		</section>
	);
}

const terminal: Record<Platform, string> = {
	darwin: "Terminal and press Return",
	linux: "a terminal and press Enter",
	windows: "PowerShell and press Enter",
};

/** The whole page while an update installs, or why it did not. */
export function Updating({
	target,
	current,
	failure,
	platform,
	onBack,
}: {
	target: string;
	current: string;
	failure: { message: string; command: string } | null;
	platform: Platform;
	onBack: () => void;
}) {
	const [copied, setCopied] = useState(false);
	if (!failure) {
		return (
			<main className="center" aria-busy="true">
				<section className="card">
					<h1>Updating Revisions</h1>
					<p role="status">
						<span className="spinner" aria-hidden="true" /> Installing version{" "}
						{shown(target)}. This tab comes back by itself when it is ready.
					</p>
				</section>
			</main>
		);
	}
	return (
		<main className="center">
			<section className="card">
				<h1>Revisions was not updated</h1>
				<p role="alert">{failure.message}</p>
				{failure.command && (
					<>
						<p>To update by hand, paste this line into {terminal[platform]}:</p>
						<pre className="command">
							<code>{failure.command}</code>
						</pre>
						<button
							type="button"
							onClick={() =>
								navigator.clipboard
									.writeText(failure.command)
									.then(() => setCopied(true))
							}
						>
							{copied ? "Copied" : "Copy"}
						</button>
					</>
				)}
				<div className="row end">
					<button type="button" className="primary" onClick={onBack}>
						Continue with version {shown(current)}
					</button>
				</div>
			</section>
		</main>
	);
}
