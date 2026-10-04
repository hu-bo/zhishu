import base from '../../eslint.config.mjs';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';

export default [
  ...base,
  { ignores: ['src/api/generated/**', 'src/routeTree.gen.ts'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks, 'react-refresh': refresh },
    rules: {
      ...hooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true, allowExportNames: ['Route', 'buttonVariants'] },
      ],
    },
  },
  {
    // File-based routing: route files export the `Route` config object that
    // references local components — a pattern fast-refresh cannot model, and
    // which TanStack Router generates for every route.
    files: ['src/routes/**/*.{ts,tsx}'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
];
