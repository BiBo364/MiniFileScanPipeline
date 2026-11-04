import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  {
    files: ['services/api/public/app.js'],
    languageOptions: {
      globals: {
        clearInterval: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
  ...tseslint.configs.recommended,
);
