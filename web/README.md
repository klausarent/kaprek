# loryme web UI

Vite + React 18 + TypeScript single-page app for loryme. Built separately
from the root package and served as static files by the local Node server
(`src/server/server.mjs`) — no runtime dependency on Vite or React is added
to the root `package.json`.

## Build

From the repo root:

```
npm run build:web
```

This runs `vite build` in `web/`, producing `web/dist/`. The CLI
(`bin/cli.mjs`) picks up `web/dist` automatically if it exists and serves it
at `/`; without a build, the server falls back to a plain "API only" status
page.

## Dev workflow

There is no dev proxy — the UI is designed to be served from the same origin
as the API (`GET /api/*`), and the server's DNS-rebinding guard only accepts
`127.0.0.1`/`localhost` Host headers on its own bound port, so pointing
Vite's dev server at a different port and proxying would fight that guard
for no benefit. Two practical options while iterating on the UI:

1. **Rebuild-on-save + real server (recommended for checking real data):**

   ```
   node bin/cli.mjs --no-open        # terminal 1 — serves web/dist on 127.0.0.1
   cd web && npx vite build --watch  # terminal 2 — rebuilds dist/ on change
   ```

   Reload the browser tab after each rebuild. Slower than HMR, but exercises
   the exact same static-serving path (`serveStatic()` in server.mjs) real
   users hit.

2. **`vite preview` against a built `dist/`** for a quick visual check
   without the Node API server (data fetches will fail with no `/api/*`
   backing them — useful only for layout/style iteration):

   ```
   npm run build
   npm run preview
   ```

## Routing

No router dependency. `web/src/App.tsx` implements a small hash-based router
(`#/`, `#/project/<slug>`, `#/session/<slug>/<sessionId>`) — sufficient for
a two-page app and keeps the runtime dependency list at just `react` +
`react-dom`.
