import { type FormEvent, type ReactNode, useRef, useState } from "react";
import {
	type Auth,
	getSettings,
	putSettings,
	type Settings,
	signOut,
} from "../api/client";
import { explain } from "./errors";
import { shown } from "./Update";

type Appearance = "system" | "light" | "dark";
const THEME_KEY = "revisions.theme";

// The colour scheme is a per-viewer preference kept in this browser;
// public/theme.js applies it, before first paint on a load.
function savedAppearance(): Appearance {
	try {
		const v = localStorage.getItem(THEME_KEY);
		return v === "light" || v === "dark" ? v : "system";
	} catch {
		return "system";
	}
}

function saveAppearance(appearance: Appearance) {
	try {
		if (appearance === "system") localStorage.removeItem(THEME_KEY);
		else localStorage.setItem(THEME_KEY, appearance);
	} catch {
		// Without storage the choice lasts until the page reloads.
		document.documentElement.dataset.theme =
			appearance === "system"
				? matchMedia("(prefers-color-scheme: dark)").matches
					? "dark"
					: "light"
				: appearance;
		return;
	}
	window.dispatchEvent(new Event("revisions:theme"));
}

/** The Settings button and its dialog. */
export function SettingsButton({
	auth,
	onSignedOut,
	onQuit,
	version,
	updateNotice,
}: {
	auth: Auth;
	onSignedOut: () => void;
	/** Saves pending edits and stops Revisions; resolves with a reason when it would not. */
	onQuit: () => Promise<string>;
	/** The running version, "" until known. */
	version: string;
	/** The update notice, when a newer version is available. */
	updateNotice: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [form, setForm] = useState<Settings | null>(null);
	const [message, setMessage] = useState("");
	const [appearance, setAppearance] = useState<Appearance>(savedAppearance);

	const show = async () => {
		setMessage("");
		setAppearance(savedAppearance());
		try {
			const current = await getSettings();
			setForm({
				...current,
				authorId: current.authorId || auth.suggestedAuthorId,
				authorName: current.authorName || auth.user?.name || "",
			});
		} catch (error) {
			// The dialog opens anyway, so the reason is seen.
			setForm(null);
			setMessage(explain(error));
		}
		dialog.current?.showModal();
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!form) return;
		saveAppearance(appearance);
		try {
			await putSettings(form);
			dialog.current?.close();
		} catch (error) {
			setMessage(explain(error));
		}
	};

	const leave = async () => {
		try {
			await signOut();
			dialog.current?.close();
			onSignedOut();
		} catch (error) {
			setMessage(explain(error));
		}
	};

	const [quitting, setQuitting] = useState(false);
	const stop = async () => {
		setMessage("");
		setQuitting(true);
		try {
			const why = await onQuit();
			if (why) setMessage(why);
		} catch (error) {
			setMessage(explain(error));
		}
		setQuitting(false);
	};
	const quitRow = (
		<>
			{version && (
				<div className="account">
					<span className="muted">Revisions {shown(version)}</span>
				</div>
			)}
			{updateNotice}
			<div className="account">
				<span className="muted">
					Revisions keeps running after this tab closes.
				</span>
				<button type="button" onClick={stop} disabled={quitting}>
					Quit Revisions
				</button>
			</div>
		</>
	);

	return (
		<>
			<button type="button" className="quiet" onClick={show}>
				Settings
			</button>
			<dialog ref={dialog} aria-labelledby="settings-title">
				{!form && (
					<div className="settings">
						<h2 id="settings-title">Settings</h2>
						<p role="alert" className="alert">
							Your settings could not be loaded. {message}
						</p>
						{quitRow}
						<div className="row end">
							<button type="button" onClick={() => dialog.current?.close()}>
								Close
							</button>
						</div>
					</div>
				)}
				{form && (
					<form onSubmit={save} className="settings">
						<h2 id="settings-title">Settings</h2>
						<label>
							Author ID
							<input
								value={form.authorId}
								pattern="[A-Za-z0-9]*"
								title="Letters and digits only"
								onChange={(e) => setForm({ ...form, authorId: e.target.value })}
								aria-describedby="author-id-help"
							/>
						</label>
						<p id="author-id-help" className="help">
							Short initials, such as GH, that mark your comments and tracked
							changes in the manuscript.
						</p>
						<label>
							Your name
							<input
								value={form.authorName}
								onChange={(e) =>
									setForm({ ...form, authorName: e.target.value })
								}
							/>
						</label>
						<label>
							Build time limit, in seconds
							<input
								type="number"
								min={10}
								max={7200}
								required
								value={form.buildTimeoutSeconds}
								onChange={(e) =>
									setForm({
										...form,
										buildTimeoutSeconds: e.target.valueAsNumber,
									})
								}
								aria-describedby="timeout-help"
							/>
						</label>
						<p id="timeout-help" className="help">
							A PDF build that takes longer than this is stopped. Raise it if a
							large manuscript needs more time.
						</p>
						<label>
							Appearance
							<select
								value={appearance}
								onChange={(e) => setAppearance(e.target.value as Appearance)}
								aria-describedby="appearance-help"
							>
								<option value="system">System (same as this computer)</option>
								<option value="light">Light</option>
								<option value="dark">Dark</option>
							</select>
						</label>
						<p id="appearance-help" className="help">
							Kept in this browser only.
						</p>
						{message && (
							<p role="alert" className="alert">
								{message}
							</p>
						)}
						<div className="account">
							<span className="muted">
								{auth.user
									? `Signed in to GitHub as ${auth.user.login}`
									: "Signed in to GitHub"}
							</span>
							<button type="button" className="quiet" onClick={leave}>
								Sign out
							</button>
						</div>
						{quitRow}
						<div className="row end">
							<button type="button" onClick={() => dialog.current?.close()}>
								Cancel
							</button>
							<button type="submit" className="primary">
								Save
							</button>
						</div>
					</form>
				)}
			</dialog>
		</>
	);
}
