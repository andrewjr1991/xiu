// Error-level gate only: rules that catch real mistakes, not style.
// Formatting and stricter typed rules are deliberately left out for now.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "**/node_modules/**", "apps/desktop/release/**", "apps/desktop/dist/**", "apps/desktop/out/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // Terminal and clipboard handling matches ANSI/control bytes on purpose.
      "no-control-regex": "off",
      // Best-effort cleanup (kill, unlink, notify) intentionally ignores failures.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Cleanup closures registered before a value exists must keep `let`.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true, allowShortCircuit: true }],
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
