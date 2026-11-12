import { useCallback, useEffect, useRef, useState } from "react";
import {
	ApiError,
	type Auth,
	type Env,
	getAuth,
	getEnv,
	getUpdate,
	installUpdate,
	type Platform,
	ping,
	quit,
	type UpdateInfo,
} from "../api/client";
import { explain } from "./errors";
import { GitGuidance } from "./Guidance";
import { Home } from "./Home";
import { ProjectView } from "./Project";
import { useRoute } from "./route";
import { SettingsButton } from "./Settings";
import { SignIn } from "./SignIn";
import { UpdateNotice, Updating } from "./Update";

const startAgain: Record<Platform, string> = {
	darwin:
		"To start it again, press Command-Space, type Revisions, and press Return.",
	windows:
		"To start it again, press the Windows key, type Revisions, and press Enter.",
	linux: "To start it again, open Revisions from your applications menu.",
};

/** Start-up checks, then sign-in, home, or a project. */
export function App() {
	const [env, setEnv] = useState<Env | null>(null);
	const [auth, setAuth] = useState<Auth | null>(null);
	const [failure, setFailure] = useState("");
	const [stopped, setStopped] = useState(false);
	const route = useRoute();
	// The open project's save of pending edits; false when it failed.
	const saveBeforeQuit = useRef<() => Promise<boolean>>(async () => true);

	const check = useCallback(async () => {
		try {
			const [e, a] = await Promise.all([getEnv(), getAuth()]);
			setEnv(e);
			setAuth(a);
			setFailure("");
		} catch (error) {
			setFailure(explain(error));
		}
	}, []);
	useEffect(() => {
		check();
	}, [check]);

	// The server looks for a newer release in the background; this asks it
	// what it found, often enough to see the answer soon after a start.
	const [update, setUpdate] = useState<UpdateInfo | null>(null);
	useEffect(() => {
		const load = () => getUpdate().then(setUpdate, () => {});
		load();
		const timer = setInterval(load, 60_000);
		return () => clearInterval(timer);
	}, []);
	const [updating, setUpdating] = useState<{
		target: string;
		failure: { message: string; command: string } | null;
	} | null>(null);

	const updateApp = useCallback(async () => {
		const target = update?.available;
		if (!target) return "";
		if (!(await saveBeforeQuit.current()))
			return "Revisions was not updated, because your latest changes could not be saved. See the message above the editor.";
		setUpdating({ target, failure: null });
		try {
			await installUpdate();
		} catch (error) {
			setUpdating({
				target,
				failure: {
					message: explain(error),
					command:
						error instanceof ApiError ? String(error.extra.command ?? "") : "",
				},
			});
			return "";
		}
		// The server restarts on the new version; the page reloads once it
		// answers, to pick up the new page and token.
		for (let i = 0; i < 180; i++) {
			await new Promise((r) => setTimeout(r, 500));
			const answer = await ping().catch(() => null);
			if (answer?.version === target) {
				window.location.reload();
				return "";
			}
		}
		setUpdating({
			target,
			failure: {
				message: `Revisions did not start again after the update. ${startAgain[env?.platform ?? "linux"]}`,
				command: "",
			},
		});
		return "";
	}, [update, env]);

	const quitApp = useCallback(async () => {
		if (!(await saveBeforeQuit.current()))
			return "Revisions is still running, because your latest changes could not be saved. See the message above the editor.";
		await quit();
		setStopped(true);
		return "";
	}, []);

	if (stopped) {
		return (
			<main className="center">
				<section className="card">
					<h1>Revisions has stopped</h1>
					<p>Your changes are saved. You can close this tab.</p>
					<p>{startAgain[env?.platform ?? "linux"]}</p>
				</section>
			</main>
		);
	}
	if (updating) {
		return (
			<Updating
				target={updating.target}
				current={update?.version ?? ""}
				failure={updating.failure}
				platform={env?.platform ?? "linux"}
				onBack={() => setUpdating(null)}
			/>
		);
	}
	if (failure) {
		return (
			<main className="center">
				<section className="card">
					<h1>Revisions is not available</h1>
					<p role="alert">{failure}</p>
					<button type="button" className="primary" onClick={check}>
						Try again
					</button>
				</section>
			</main>
		);
	}
	if (!env || !auth) {
		return (
			<main className="center" aria-busy="true">
				<p className="muted">Loading…</p>
			</main>
		);
	}
	if (!env.git.found) {
		return <GitGuidance platform={env.platform} onCheck={check} />;
	}
	if (!auth.signedIn) return <SignIn onSignedIn={check} />;

	const notice = update && (
		<UpdateNotice update={update} onUpdate={updateApp} />
	);
	const settings = (
		<SettingsButton
			auth={auth}
			onSignedOut={check}
			onQuit={quitApp}
			version={update?.version ?? ""}
			updateNotice={notice}
		/>
	);
	if (route.name === "repo") {
		return (
			<ProjectView
				key={route.id}
				id={route.id}
				env={env}
				settings={settings}
				updateNotice={notice}
				saveBeforeQuit={saveBeforeQuit}
				onEnvChange={setEnv}
				onAuthLost={check}
			/>
		);
	}
	return (
		<div className="page">
			<header className="topbar">
				<a className="brand" href="#/">
					Revisions
				</a>
				<span className="spacer" />
				{settings}
			</header>
			{notice}
			<Home onGitMissing={check} onSignedOut={check} />
		</div>
	);
}
