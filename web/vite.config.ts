import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	// The bundle is served from loopback, so its size costs nothing to fetch;
	// pdf.js alone is about 1 MB.
	build: { chunkSizeWarningLimit: 2000 },
	test: { include: ["src/**/*.test.{ts,tsx}"] },
});
