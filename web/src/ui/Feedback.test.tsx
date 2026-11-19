// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { ErrorBoundary } from "./Feedback";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): never {
	throw new Error("kaboom");
}

test("Crash: a page that fails to draw explains itself and offers to report and reload", () => {
	const host = document.createElement("div");
	const root = createRoot(host, { onCaughtError: () => {} });
	act(() =>
		root.render(
			<ErrorBoundary>
				<Boom />
			</ErrorBoundary>,
		),
	);
	expect(host.textContent).toContain("Something went wrong");
	const report = [...host.querySelectorAll("a")].find(
		(a) => a.textContent === "Report this problem",
	);
	const p = new URL(report?.href ?? "").searchParams;
	expect(p.get("template")).toBe("bug.yml");
	expect(p.get("problem")).toBe("Error: kaboom");
	expect(report?.target).toBe("_blank");
	expect(
		[...host.querySelectorAll("button")].some(
			(b) => b.textContent === "Reload",
		),
	).toBe(true);
	act(() => root.unmount());
});
