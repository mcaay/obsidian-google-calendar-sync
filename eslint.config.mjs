import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
    { ignores: ['main.js', 'dist/**', 'node_modules/**'] },
    js.configs.recommended,
    ...ts.configs.recommended,
    {
        files: ['src/**/*.ts', 'tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'error',
            'no-irregular-whitespace': 'error',
        },
    },
);
