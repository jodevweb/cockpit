import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["dist/", "src-tauri/", "src/lib/generated/", "test-results/", "playwright-report/"] },
	{ linterOptions: { reportUnusedDisableDirectives: "error" } },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["src/**/*.{ts,tsx}"],
		languageOptions: { globals: globals.browser },
		plugins: { "react-hooks": reactHooks },
		rules: {
			"react-hooks/rules-of-hooks": "error",
			// Une exception reste possible, mais elle dit pourquoi : un tableau de
			// dépendances faux se voit mal, et se paie en données périmées.
			"react-hooks/exhaustive-deps": "error",
		},
	},
	{ files: ["scripts/**", "e2e/**"], languageOptions: { globals: globals.node } },
);
