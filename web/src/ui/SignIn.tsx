import { useEffect, useState } from "react";
import { type DeviceCode, pollDevice, startDevice } from "../api/client";
import { explain, isCode } from "./errors";

type Step =
	| { name: "idle" }
	| { name: "starting" }
	| { name: "code"; code: DeviceCode }
	| { name: "failed"; message: string };

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

	const start = async () => {
		setStep({ name: "starting" });
		try {
			setStep({ name: "code", code: await startDevice() });
		} catch (error) {
			setStep({
				name: "failed",
				message: isCode(error, "not_configured")
					? "This copy of Revisions cannot sign in to GitHub because it was built without a GitHub app key. Ask the person who sent you Revisions for a new copy."
					: explain(error),
			});
		}
	};

	// The server forwards a poll to GitHub only when GitHub's interval has
	// passed, so polling every second is safe.
	const polling = step.name === "code";
	useEffect(() => {
		if (!polling) return;
		const timer = setInterval(async () => {
			try {
				const status = await pollDevice();
				if (status === "ok") onSignedIn();
				else if (status !== "pending") {
					setStep({ name: "failed", message: outcome[status] });
				}
			} catch (error) {
				setStep({ name: "failed", message: explain(error) });
			}
		}, 1000);
		return () => clearInterval(timer);
	}, [polling, onSignedIn]);

	return (
		<main className="center">
			<section className="card signin">
				<h1>Welcome to Revisions</h1>
				<p>
					Revisions opens a manuscript that a co-author shared with you on
					GitHub, and sends your changes back. First, sign in with your GitHub
					account.
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
						<button
							type="button"
							className="primary large"
							onClick={start}
							disabled={step.name === "starting"}
						>
							{step.name === "failed" ? "Start again" : "Sign in with GitHub"}
						</button>
					</>
				)}
			</section>
		</main>
	);
}
