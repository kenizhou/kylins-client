import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettierConfig from 'eslint-config-prettier';

// Flat config (ESLint 10). See CLAUDE.md / engineering-review skill.
// Layers, last-to-first: Prettier compat disables formatting rules that
// conflict with `prettier` so ESLint owns correctness, Prettier owns format.
export default tseslint.config(
  // Files we never want to lint.
  {
    ignores: ['dist', 'coverage', 'node_modules', 'plugins/example-plugin/**', '**/*.d.ts'],
  },

  // TypeScript app + test source.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // React hooks rules are the highest-value catches (dependency arrays,
      // rules of hooks) — they would have flagged the re-render bugs we hit.
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // TypeScript already reports undefined identifiers; leave no-undef off
      // for TS so browser/node/vitest globals don't fire false positives.
      'no-undef': 'off',
      // Allow intentionally-unused params/vars caught-errors prefixed with "_"
      // (used by stub provider methods awaiting implementation).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Plain JS (build/config files).
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Prettier compatibility — must be last so it can turn off conflicting rules.
  prettierConfig,
);
