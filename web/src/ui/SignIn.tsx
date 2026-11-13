import { useCallback, useEffect, useRef, useState } from "react";
import {
	ApiError,
	type DeviceCode,
	pollDevice,
	reconnectGitHub,
	startDevice,
} from "../api/client";
import { explain, isCode } from "./errors";

type Step =
	| { name: "idle" }
	| { name: "starting" }
	| { name: "code"; code: DeviceCode }
	| { name: "failed"; message: string; override?: boolean };

const outcome: Record<"expired" | "denied", string> = {
	expired:
		"The code expired before GitHub received it. Start again to get a new code.",
	denied:
		"Sign-in was cancelled on GitHub. Start again if you want to sign in.",
};

/** The OAuth device flow: show the code, send the user to GitHub, poll. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
	const [step, setStep] = useState<Step>({ name: "idle" });
	const [copied, setCopied] = useState(false);
	const live = useRef(true);

	const start = useCallback(
		async (renew = true) => {
			setStep({ name: "starting" });
			try {
				if (renew) {
					const auth = await reconnectGitHub();
					if (!live.current) return;
					if (auth.signedIn && !auth.problem) {
						onSignedIn();
						return;
					}
					if (auth.problem && auth.problem.code !== "auth_required")
						throw new ApiError(
							502,
							auth.problem.code,
							auth.problem.message,
							{},
						);
				}
				if (!live.current) return;
				const code = await startDevice();
				if (live.current) setStep({ name: "code", code });
			} catch (error) {
				if (!live.current) return;
				setStep({
					name: "failed",
					override: isCode(error, "auth_override"),
					message: isCode(error, "not_configured")
						? "This copy of Revisions cannot sign in to GitHub because it was built without a GitHub app key. Ask the person who sent you Revisions for a new copy."
						: explain(error),
				});
			}
		},
		[onSignedIn],
	);
	useEffect(() => {
		live.current = true;
		void start();
		return () => {
			live.current = false;
		};
	}, [start]);

	// The server forwards a poll to GitHub only when GitHub's interval has
	// passed, so polling every second is safe.
	const polling = step.name === "code";
	useEffect(() => {
		if (!polling) return;
		let active = true;
		let busy = false;
		const timer = setInterval(async () => {
			if (busy) return;
			busy = true;
			try {
				const status = await pollDevice();
				if (!active) return;
				if (status === "ok") onSignedIn();
				else if (status !== "pending") {
					setStep({ name: "failed", message: outcome[status] });
				}
			} catch (error) {
				if (active) setStep({ name: "failed", message: explain(error) });
			} finally {
				busy = false;
			}
		}, 1000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [polling, onSignedIn]);

	return (
		<section className="signin">
			<p>
				Revisions opens a manuscript that a co-author shared with you on GitHub,
				and sends your changes back. Reconnect with your GitHub account. Your
				work stays open; retry the action yourself afterwards.
			</p>
			{step.name === "code" ? (
				<>
					<ol className="steps">
						<li>
							<p>Copy this one-time code:</p>
							<div className="row">
								<output className="device-code" aria-label="One-time code">
									{step.code.userCode}
								</output>
								<button
									type="button"
									onClick={() =>
										navigator.clipboard
											.writeText(step.code.userCode)
											.then(() => setCopied(true))
									}
								>
									{copied ? "Copied" : "Copy code"}
								</button>
							</div>
						</li>
						<li>
							<p>Paste it on GitHub and confirm:</p>
							<button
								type="button"
								className="primary"
								onClick={() =>
									window.open(step.code.verificationUri, "_blank", "noopener")
								}
							>
								Open GitHub in a new tab
							</button>
						</li>
					</ol>
					<p className="muted waiting" aria-live="polite">
						<span className="spinner" aria-hidden="true" /> Waiting for GitHub
						to confirm the code…
					</p>
				</>
			) : (
				<>
					{step.name === "failed" && (
						<p role="alert" className="alert">
							{step.message}
						</p>
					)}
					{!(step.name === "failed" && step.override) && (
						<button
							type="button"
							className="primary large"
							onClick={() => start(false)}
							disabled={step.name === "starting"}
						>
							{step.name === "failed"
								? "Start a new sign-in"
								: "Sign in with GitHub"}
						</button>
					)}
				</>
			)}
		</section>
	);
}
