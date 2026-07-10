import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".agent/**",
      ".artifacts/**",
      "portable/**",
      "test-fixtures/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-constant-condition": ["error", { checkLoops: false }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["packages/*/src/**/*.{ts,tsx}"],
    rules: {
      complexity: ["error", 15],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }],
    },
  },
);
