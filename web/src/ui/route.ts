// Hash routing: `#/` is home and `#/r/<host>/<owner>/<name>` is a project.
import { useSyncExternalStore } from "react";
import type { RepoId } from "../api/client";

export type Route = { name: "home" } | { name: "repo"; id: RepoId };

function subscribe(onChange: () => void) {
	window.addEventListener("hashchange", onChange);
	return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): Route {
	const hash = useSyncExternalStore(subscribe, () => window.location.hash);
	const match = /^#\/r\/([^/]+\/[^/]+\/[^/]+)$/.exec(hash);
	return match?.[1] ? { name: "repo", id: match[1] } : { name: "home" };
}

export const repoHref = (id: RepoId) => `#/r/${id}`;
