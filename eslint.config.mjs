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
      // Every ignored failure in product code states why (A5). Best-effort
      // cleanup still swallows the error, with a comment in the catch block.
      "no-empty": "error",
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
    // Test cleanup may ignore failures silently; the subject under test is elsewhere.
    files: ["test/**"],
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
