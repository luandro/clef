import { bindings, defineConfig } from "cf/config";

/**
 * Secret-like files were detected but not read or migrated: .env. Only `secrets.required` entries are migrated.
 * @see https://developers.cloudflare.com/workers/configuration/secrets/
 */

export default defineConfig({
	worker: {
		name: "clef-proxy",
		compatibilityDate: "2026-10-04",
		entrypoint: "src/index.js",
		workersDev: true,
		observability: {
			enabled: true,
		},
		env: {
			AI: bindings.ai({}),
			CLEF_TOKEN: bindings.secret(),
		},
	},
});
