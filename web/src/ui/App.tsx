import { useCallback, useEffect, useRef, useState } from "react";
import {
	ApiError,
	type Auth,
	type AuthProblem,
	cancelDevice,
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
import { Modal } from "./Git";
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
	const [authProblem, setAuthProblem] = useState<AuthProblem | null>(null);
	const [reconnecting, setReconnecting] = useState(false);
	const [stopped, setStopped] = useState(false);
	const route = useRoute();
	// The open project's save of pending edits; false when it failed.
	const saveBeforeQuit = useRef<() => Promise<boolean>>(async () => true);

	const check = useCallback(async () => {
		try {
			setEnv(await getEnv());
			setFailure("");
			try {
				const a = await getAuth();
				setAuth(a);
				if (a.problem) setAuthProblem(a.problem);
			} catch (error) {
				setAuth(
					(a) => a ?? { signedIn: false, user: null, suggestedAuthorId: "" },
				);
				setAuthProblem({
					code: error instanceof ApiError ? error.code : "host_unreachable",
					message: explain(error),
				});
			}
		} catch (error) {
			setFailure(explain(error));
		}
	}, []);
	useEffect(() => {
		check();
	}, [check]);

	useEffect(() => {
		const problem = (event: Event) => {
			const detail = (event as CustomEvent<AuthProblem>).detail;
			setAuthProblem(detail);
			void check().then(() => {
				if (detail.code === "auth_changed")
					window.dispatchEvent(new Event("revisions:auth-changed"));
			});
		};
		const reconnect = () => setReconnecting(true);
		window.addEventListener("revisions:auth-problem", problem);
		window.addEventListener("revisions:reconnect", reconnect);
		return () => {
			window.removeEventListener("revisions:auth-problem", problem);
			window.removeEventListener("revisions:reconnect", reconnect);
		};
	}, [check]);

	const recovered = useCallback(async () => {
		setAuthProblem(null);
		setReconnecting(false);
		await check();
		window.dispatchEvent(new Event("revisions:auth-changed"));
	}, [check]);
	const cancelled = useCallback(() => {
		setReconnecting(false);
		void cancelDevice().catch((error) =>
			setAuthProblem({ code: "storage_failed", message: explain(error) }),
		);
	}, []);

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
	if (failure && !env) {
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

	const notice = update && (
		<UpdateNotice update={update} onUpdate={updateApp} />
	);
	const settings = (
		<SettingsButton
			auth={auth}
			onSignedOut={recovered}
			onReconnect={() => setReconnecting(true)}
			onQuit={quitApp}
			version={update?.version ?? ""}
			updateNotice={notice}
		/>
	);
	return (
		<>
			{route.name === "repo" ? (
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
			) : (
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
			)}
			{(authProblem || !auth.signedIn || failure) && (
				<aside className="auth-notice" aria-label="GitHub connection">
					<p role="status">
						{failure ||
							authProblem?.message ||
							"Sign in to GitHub to open shared links and send changes. Copies on this computer still work without sign-in."}
					</p>
					{authProblem?.code === "auth_changed" ? (
						<button type="button" onClick={() => setAuthProblem(null)}>
							Dismiss
						</button>
					) : (
						authProblem?.code !== "auth_override" && (
							<button type="button" onClick={() => setReconnecting(true)}>
								{authProblem ? "Reconnect GitHub" : "Sign in with GitHub"}
							</button>
						)
					)}
				</aside>
			)}
			{reconnecting && (
				<Modal title="Reconnect GitHub" onClose={cancelled}>
					<SignIn onSignedIn={recovered} />
					<div className="row end">
						<button type="button" onClick={cancelled}>
							Not now
						</button>
					</div>
				</Modal>
			)}
		</>
	);
}
