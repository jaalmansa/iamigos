import js from '@eslint/js';
import globals from 'globals';

// Rules shared by all the JavaScript in the repo.
const rules = {
    'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrors: 'none'}],
    'no-var': 'error',
    'prefer-const': 'error',
    'eqeqeq': ['error', 'always', {null: 'ignore'}],
    'curly': ['error', 'multi-or-nest', 'consistent'],
    'no-console': 'off',
};

export default [
    {ignores: ['**/dist/', '**/node_modules/', 'docs/', 'opencode/', 'desktop/src/shared/']},
    js.configs.recommended,

    // GNOME Shell extension and its preferences (GJS).
    {
        files: ['gnome-extension/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                global: 'readonly',     // Shell global object
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                console: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
            },
        },
        rules,
    },

    // Installer, tools and tests (Node).
    {
        files: ['bin/**/*.mjs', 'tools/**/*.mjs', 'test/**/*.mjs', '*.js', 'desktop/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: globals.node,
        },
        rules,
    },

    // Desktop app: CommonJS bits (preload, electron-builder config) and the strip page.
    {
        files: ['desktop/**/*.cjs'],
        languageOptions: {ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node},
        rules,
    },
    {
        files: ['desktop/src/strip/strip.js'],
        languageOptions: {ecmaVersion: 2024, sourceType: 'script', globals: globals.browser},
        rules,
    },
];
