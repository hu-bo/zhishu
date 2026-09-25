import { defineConfig } from 'orval';

export default defineConfig({
  workflow: {
    input: { target: '../workflow-server/openapi.json' },
    output: {
      target: './src/api/generated/workflow-api.ts',
      schemas: './src/api/generated/models',
      mode: 'split',
      client: 'react-query',
      httpClient: 'fetch',
      clean: true,
      tsconfig: './tsconfig.app.json',
      override: {
        mutator: { path: './src/api/transport.ts', name: 'apiFetch' },
        fetch: { includeHttpResponseReturnType: false },
        query: { useQuery: true, useMutation: false, signal: true },
        operations: {
          createWorkflow: { query: { useQuery: false, useMutation: true } },
          updateWorkflow: { query: { useQuery: false, useMutation: true } },
          deleteWorkflow: { query: { useQuery: false, useMutation: true } },
        },
      },
    },
  },
});
