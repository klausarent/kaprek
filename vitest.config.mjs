import { defineConfig } from 'vitest/config';

// Files whose slowest GREEN test needed at least 4 s with 4 workers on the
// shared Windows server (KAP-35, 27.10.2026, full run with 60 s limits): they
// spawn processes, boot an HTTP server or replay data files, and under load
// they take 4-42 s per test (idle: under 1.6 s). Everything else keeps the
// unit-tier limit below, so a test that hangs there still fails fast.
const SLOW_FILES = [
  'src/relay/dispatcher.test.mjs',
  'src/legacy-datadir.test.mjs',
  'src/doctor/doctor.test.mjs',
  'src/relay/graph.test.mjs',
  'src/orchestrator/run.test.mjs',
  'src/triggers/runner.test.mjs',
  'src/server/server.test.mjs',
  'src/harness/knownTools.test.mjs',
  'src/server/grants.http.test.mjs',
  'src/server/budget.http.test.mjs',
  'src/server/grants.shape.http.test.mjs',
  'src/resume/scan.test.mjs',
  'src/triggers/condition.test.mjs',
  'src/policy/hook-session-start.test.mjs',
  'src/server/leitstand.test.mjs',
  'src/server/mission-memory.test.mjs',
  'src/server/approval-store.test.mjs',
  'src/apps/mcp-server.test.mjs',
  'src/policy/policy.test.mjs',
  'src/cli/cli.test.mjs',
  'src/scan/scan.test.mjs',
  'src/server/mission-digest.test.mjs',
  'src/harness/peers/glm.test.mjs',
  'src/harness/account-exec.test.mjs',
  'src/artifacts/preserve.test.mjs',
  'src/accounts/session.test.mjs',
  'src/cli/hooks.test.mjs',
  'src/memory/sync.test.mjs',
  // Reads every source file; 12.0 s and 26.1 s in two later full runs.
  'src/no-network.test.mjs',
];

// Slowest green test measured: 41.5 s (relay/dispatcher); single tests in
// server.test and triggers/runner reached 64-70 s. 120 s leaves room for a
// load spike and still ends a real hang.
const SLOW_TIMEOUT_MS = 120_000;

export default defineConfig({
  test: {
    environment: 'node',
    // Default is one worker per core (23 here). With 23 workers the full run
    // took 2671 s and 412 tests timed out while the CPU sat at 4-19 %: the
    // workers starve each other on file and module access. 4 workers: 886 s.
    maxWorkers: 4,
    // Stock limits are 5 s / 10 s. In a full run with the fix above, nine files
    // outside SLOW_FILES had one test each take 5.0-12.0 s under load (idle:
    // milliseconds). 20 s covers that with room; a real hang still fails.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.mjs'], exclude: SLOW_FILES },
      },
      {
        extends: true,
        test: { name: 'slow', include: SLOW_FILES, testTimeout: SLOW_TIMEOUT_MS, hookTimeout: SLOW_TIMEOUT_MS },
      },
    ],
  },
});
