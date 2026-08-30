import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  /* `_to_delete` is the graveyard — untracked, never built, and it holds a
     deliberately broken file from Aug 26 that made `npm run lint` fail for the
     whole repo. Dead code is not linted. */
  { ignores: ["dist", "_to_delete"] },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z_]" }],
      // Fetch-on-mount (an async load() that setStates when data arrives)
      // is the data pattern this app — and the platform — is built on.
      // The React-Compiler-era advisory rule flags it; we accept the
      // pattern deliberately.
      "react-hooks/set-state-in-effect": "off",
    },
  },
];
