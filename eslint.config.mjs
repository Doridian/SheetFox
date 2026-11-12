import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import eslintPrettierRecommended from 'eslint-plugin-prettier/recommended';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import unicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';

/* eslint-disable */

export default defineConfig(
  { ignores: ['dist', 'dist-server', 'data', 'downloads', 'eslint.config.mjs', 'ui'] },
  js.configs.all,
  ...tseslint.configs.all,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  reactHooks.configs.flat.recommended,
  eslintPrettierRecommended,
  unicorn.configs.all,
  {
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',

      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },

    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()],
    },

    rules: {
      'arrow-body-style': 'off',
      camelcase: 'off',
      'class-methods-use-this': 'off',
      'max-len': ['error', { code: 200, ignoreStrings: true, ignoreTemplateLiterals: true }],
      'eol-last': 'off',
      eqeqeq: ['error', 'always'],
      'linebreak-style': 'off',
      'no-underscore-dangle': 'off',

      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lodash',
              message: 'Only submodule imports are permitted.',
            },
          ],
        },
      ],

      'no-inline-comments': [
        'error',
        {
          ignorePattern: 'webpack.*?:\\s.+',
        },
      ],

      'sort-imports': [
        'error',
        {
          ignoreCase: true,
          ignoreDeclarationSort: true,
        },
      ],

      'sort-keys': 'off',
      'no-warning-comments': 'off',
      'func-style': 'off',
      'no-ternary': 'off',
      'id-length': 'off',
      'default-case': 'off',
      'consistent-return': 'off',
      'max-lines-per-function': ['error', 250],
      complexity: ['error', 20],
      'no-undefined': 'off',
      'no-plusplus': 'off',
      'no-param-reassign': 'off',
      'no-continue': 'off',
      'max-statements': ['error', 150],
      'max-lines': ['error', 1000],
      'max-classes-per-file': ['error', 10],
      'max-params': 'off',
      'init-declarations': 'off',
      'require-unicode-regexp': 'off',
      'prefer-named-capture-group': 'off',

      'no-void': [
        'error',
        {
          allowAsStatement: true,
        },
      ],

      'spaced-comment': [
        'error',
        'always',
        {
          markers: ['/'],
        },
      ],

      'capitalized-comments': 'off',
      'object-curly-newline': 'off',
      'one-var-declaration-per-line': 'error',

      'no-implicit-coercion': [
        2,
        {
          allow: ['!!'],
        },
      ],

      'one-var': ['error', 'never'],
      'padded-blocks': 'off',
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
      'prefer-destructuring': 'error',
      'import-x/export': 'error',
      'import-x/no-default-export': 'error',

      'import-x/extensions': [
        'error',
        {
          pattern: {
            scss: 'always',
            otf: 'always',
          },
        },
      ],

      'import-x/no-duplicates': 'error',
      'import-x/no-dynamic-require': 'error',
      'import-x/no-extraneous-dependencies': 'error',
      'import-x/no-unresolved': 'error',

      // No-op since ESLint 10 (FileEnumerator API removed)
      'import-x/no-unused-modules': 'off',

      'import-x/order': [
        'error',
        {
          alphabetize: {
            order: 'asc',
          },

          'newlines-between': 'never',
        },
      ],

      'prettier/prettier': 'error',

      'no-else-return': [
        'error',
        {
          allowElseIf: false,
        },
      ],

      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/no-type-alias': 'off',
      '@typescript-eslint/no-parameter-properties': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/lines-between-class-members': 'off',
      '@typescript-eslint/prefer-enum-initializers': 'off',

      '@typescript-eslint/max-params': [
        'error',
        {
          max: 6,
        },
      ],

      '@typescript-eslint/prefer-readonly-parameter-types': [
        'off',
        {
          ignoreInferredTypes: true,
        },
      ],

      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/sort-type-constituents': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/init-declarations': 'off',
      '@typescript-eslint/no-use-before-define': 'off',
      '@typescript-eslint/method-signature-style': 'off',

      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': true,
        },
      ],

      '@typescript-eslint/member-ordering': 'error',

      // tsc already rejects real redeclarations; this only trips on zod's `const X` + `type X` pairs
      '@typescript-eslint/no-redeclare': 'off',
      '@typescript-eslint/no-shadow': [
        'error',
        {
          ignoreTypeValueShadow: true,
        },
      ],

      '@typescript-eslint/no-explicit-any': [
        'error',
        {
          ignoreRestArgs: true,
        },
      ],

      '@typescript-eslint/explicit-module-boundary-types': 'error',

      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        {
          allowConstantLoopConditions: true,
        },
      ],

      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/restrict-template-expressions': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',

      '@typescript-eslint/parameter-properties': [
        'error',
        {
          prefer: 'parameter-property',
        },
      ],

      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/name-replacements': 'off',
      'unicorn/no-await-expression-member': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/number-literal-case': 'off',
      'unicorn/explicit-length-check': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/prefer-query-selector': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/prefer-spread': 'off',
      'unicorn/no-useless-undefined': 'off',
      'unicorn/no-new-array': 'off',
      'unicorn/no-document-cookie': 'error',
      'unicorn/no-null': 'off',
      'unicorn/custom-error-definition': 'error',
      'unicorn/switch-case-braces': 'off',
      'unicorn/no-keyword-prefix': 'off',
      'unicorn/no-process-exit': 'off',
      // Newer unicorn rules that fight readable code more than they help
      'unicorn/try-complexity': 'off',
      'unicorn/max-nested-calls': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/consistent-arrow-return-style': 'off',
      'unicorn/prefer-simple-condition-first': 'off',
      'unicorn/single-line-block-comment-style': 'off',
      'unicorn/no-asterisk-prefix-in-documentation-comments': 'off',
      'unicorn/comment-content': 'off',
      'unicorn/no-computed-property-existence-check': 'off',
      // Temporal / Error.isError are not yet available in every browser we target
      'unicorn/prefer-temporal': 'off',
      'unicorn/prefer-error-is-error': 'off',
      // Conflicts with @typescript-eslint/member-ordering (public before private)
      'unicorn/consistent-class-member-order': 'off',
    },
  },
  {
    // CLI scripts and the server report progress on the console
    files: ['ingest/**', 'server/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['vite.config.ts', 'vite.server.config.ts'],
    rules: { 'import-x/no-default-export': 'off' },
  },
);
