import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import nPlugin from "eslint-plugin-n";

export default defineConfig([
  {
    ignores: ["eslint.config.js", "tests/**", "OpenDDS/**"],
  },
  js.configs.recommended,
	{
		files: ["**/*.js"],
		plugins: {
      n: nPlugin,
		},
		extends: [
      "n/recommended",
    ],
		rules: {
			"no-unused-vars": "warn",
			"no-undef": "warn",
		},
	},
]);
