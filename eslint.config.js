// Правила кода: рекомендованный набор ESLint + запрет коротких непонятных имён.
// Сервер и бот — CommonJS (Node), мини-приложение shop-public — ES-модули в браузере.
const js = require('@eslint/js');
const globals = require('globals');

const sharedRules = {
  'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
  'id-length': ['error', { min: 2, exceptions: ['_'], properties: 'never' }],
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
};

module.exports = [
  { ignores: ['node_modules/', 'src/database/generated/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: sharedRules,
  },
  {
    files: ['shop-public/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser, Telegram: 'readonly' } },
  },
  {
    files: ['tools/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
