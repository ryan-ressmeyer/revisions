import { useCallback, useEffect, useRef, useState } from "react";
import {
	type Auth,
	type Env,
	getAuth,
	getEnv,
	type Platform,
	quit,
} from "../api/client";
import { explain } from "./errors";
import { GitGuidance } from "./Guidance";
import { Home } from "./Home";
import { ProjectView } from "./Project";
import { useRoute } from "./route";
import { SettingsButton } from "./Settings";
import { SignIn } from "./SignIn";

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

	const settings = (
		<SettingsButton auth={auth} onSignedOut={check} onQuit={quitApp} />
	);
	if (route.name === "repo") {
		return (
			<ProjectView
				key={route.id}
				id={route.id}
				env={env}
				settings={settings}
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
			<Home onGitMissing={check} onSignedOut={check} />
		</div>
	);
}
