import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./Feedback";
import { noteProblem } from "./issues";
import "./styles.css";

window.addEventListener("error", (e) => noteProblem(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => noteProblem(e.reason));

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<ErrorBoundary>
				<App />
			</ErrorBoundary>
		</StrictMode>,
	);
}
