import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' — the built assets are served from the local Node server at an
// arbitrary port (e.g. http://127.0.0.1:4900/), never from a known absolute
// path, so all asset URLs must be relative to index.html.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
  },
});
