import { useCallback, useEffect, useState } from "react";
import { type Auth, type Env, getAuth, getEnv } from "../api/client";
import { explain } from "./errors";
import { GitGuidance } from "./Guidance";
import { Home } from "./Home";
import { ProjectView } from "./Project";
import { useRoute } from "./route";
import { SettingsButton } from "./Settings";
import { SignIn } from "./SignIn";

/** Start-up checks, then sign-in, home, or a project. */
export function App() {
	const [env, setEnv] = useState<Env | null>(null);
	const [auth, setAuth] = useState<Auth | null>(null);
	const [failure, setFailure] = useState("");
	const route = useRoute();

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

	const settings = <SettingsButton auth={auth} onSignedOut={check} />;
	if (route.name === "repo") {
		return (
			<ProjectView
				key={route.id}
				id={route.id}
				env={env}
				settings={settings}
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
