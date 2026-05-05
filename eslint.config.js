import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import hooksPlugin from "eslint-plugin-react-hooks";

export default [
  eslint.configs.recommended,

  {
    ignores: [
      "node_modules/",
      "dist/",
      ".wxt/",
      ".output/",
      "backup/",
      "*.config.*",
    ],
  },

  // ===== TypeScript =====
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs["recommended"].rules,
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },

  // ===== React Hooks =====
  {
    files: ["**/*.tsx"],
    plugins: {
      "react-hooks": hooksPlugin,
    },
    rules: {
      ...hooksPlugin.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },

  // ===== Global Rules (all files) =====
  {
    rules: {
      "no-console": ["warn", { allow: ["warn", "error", "log"] }],
      "no-debugger": "error",
      eqeqeq: ["warn", "smart"],
      "no-var": "error",
      "prefer-const": "warn",
      "prefer-arrow-callback": "warn",
      "no-duplicate-imports": "warn",
      "no-unused-expressions": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
    },
  },

  // ===== Browser + Extension globals =====
  {
    languageOptions: {
      globals: {
        browser: "readonly",
        chrome: "readonly",
        alert: "readonly",
        console: "readonly",
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        JSON: "readonly",
        Promise: "readonly",
        Map: "readonly",
        Set: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        File: "readonly",
        HTMLElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLImageElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLTableElement: "readonly",
        HTMLTableSectionElement: "readonly",
        HTMLTableRowElement: "readonly",
        HTMLTableCellElement: "readonly",
        HTMLTableCaptionElement: "readonly",
        KeyboardEvent: "readonly",
        MouseEvent: "readonly",
        RequestInit: "readonly",
      },
    },
  },
];
