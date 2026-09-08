import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      'lib/**',
      'node_modules/**',
      'coverage/**',
      'test/fixtures/**',
      // Retained measurement artifacts: the exact scripts that produced the README figures.
      // They are evidence, kept verbatim, not project source.
      'docs/measurements/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        // tsconfig.eslint.json widens include to test/, bench/ and config files, which the
        // build tsconfig deliberately excludes (rootDir is src/).
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs['recommended-type-checked'].rules,

      // TypeScript resolves globals from lib/@types; eslint's no-undef only duplicates that
      // check badly, flagging built-ins like URL. This is typescript-eslint's own guidance.
      'no-undef': 'off',

      // CLAUDE.md: no `any` and no ts-ignore without an adjacent justifying comment.
      // These stay as errors; the comment is what makes a local disable reviewable.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true },
      ],

      // CLAUDE.md: never swallow errors.
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/only-throw-error': 'error',

      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['test/**/*.ts', 'bench/**/*.ts', '*.config.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': 'off',
    },
  },
  {
    // The benchmark CLI is plain ESM JavaScript running under node, not part of the
    // type-checked build. It prints to stdout by design.
    files: ['bench/**/*.js', 'bench/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
];
