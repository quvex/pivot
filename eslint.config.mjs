import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/', 'site/', '.faces/', 'worker/.wrangler/'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['web/**/*.mjs', 'worker/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.browser },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
];
