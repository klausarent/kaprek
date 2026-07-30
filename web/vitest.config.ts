// Web unit tests. Run: cd web && npx vitest run
//
// environment 'node': there is no jsdom/happy-dom dependency in this package
// (zero new web dependencies, see the task's global constraints), so component
// tests walk the React element tree directly — see src/test/tree.tsx for what
// that buys and what it costs. vitest itself comes from the repo root's
// devDependencies; only the config lives here.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
