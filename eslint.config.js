'use strict';

module.exports = [
  {
    ignores: ['node_modules/**', 'data/**'],
  },
  {
    files: ['server/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'allow-null'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        io: 'readonly',
        Math: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'allow-null'],
    },
  },
];
