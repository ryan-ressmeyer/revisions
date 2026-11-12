// Sets the colour scheme on <html data-theme> before the page first paints.
// The choice is a per-viewer preference in localStorage ("light", "dark",
// or absent for the system setting); Settings changes it and dispatches
// "revisions:theme". A classic script, because the page's CSP allows only
// same-origin scripts and the module bundle runs too late to avoid a flash.
(() => {
	const root = document.documentElement;
	const system = matchMedia("(prefers-color-scheme: dark)");
	const apply = () => {
		let choice = null;
		try {
			choice = localStorage.getItem("revisions.theme");
		} catch {
			// Storage is a convenience; the system setting applies without it.
		}
		root.dataset.theme =
			choice === "light" || choice === "dark"
				? choice
				: system.matches
					? "dark"
					: "light";
	};
	apply();
	system.addEventListener("change", apply);
	window.addEventListener("storage", apply);
	window.addEventListener("revisions:theme", apply);
})();
