import { describe, it, expect } from 'vitest';
import { runStopCommand, STOP_USAGE } from './stop.mjs';

/** A `now()` that advances by `stepMs` every time `sleep` is awaited, so the 2 s poll loop runs without a real clock. */
function fakeClock(stepMs = 100) {
  let t = 0;
  return {
    now: () => t,
    sleep: async () => {
      t += stepMs;
    },
  };
}

function deps(overrides = {}) {
  const lines = [];
  const clock = fakeClock();
  return {
    lines,
    deps: {
      readLock: () => ({ pid: 111, url: 'http://127.0.0.1:4900' }),
      kill: () => {},
      isAlive: async () => false, // "server let go immediately" by default
      unlink: () => {},
      now: clock.now,
      sleep: clock.sleep,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(`ERR ${line}`),
      ...overrides,
    },
  };
}

describe('kaprek stop', () => {
  it('no instance lock: reports not running, exit 0, never touches kill/unlink', async () => {
    let killed = false;
    let unlinked = false;
    const d = deps({
      readLock: () => null,
      kill: () => {
        killed = true;
      },
      unlink: () => {
        unlinked = true;
      },
    });
    expect(await runStopCommand([], d.deps)).toBe(0);
    expect(d.lines).toEqual(['kaprek is not running']);
    expect(killed).toBe(false);
    expect(unlinked).toBe(false);
  });

  it('lock names a dead pid: reports not running, cleans up the stale lock file, exit 0', async () => {
    let unlinked = false;
    const d = deps({
      kill: (pid, signal) => {
        if (signal === 0) {
          const err = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
      },
      unlink: () => {
        unlinked = true;
      },
    });
    expect(await runStopCommand([], d.deps)).toBe(0);
    expect(d.lines).toEqual(['kaprek is not running']);
    expect(unlinked).toBe(true);
  });

  it('live pid: probes, kills, polls the port until it lets go, deletes the lock, reports the pid', async () => {
    let probeCount = 0;
    let killedForReal = false;
    let unlinked = false;
    const d = deps({
      kill: (pid, signal) => {
        expect(pid).toBe(111);
        if (signal === undefined) killedForReal = true;
      },
      isAlive: async () => {
        probeCount += 1;
        return probeCount < 3; // "still up" twice, then gone
      },
      unlink: () => {
        unlinked = true;
      },
    });
    expect(await runStopCommand([], d.deps)).toBe(0);
    expect(killedForReal).toBe(true);
    expect(probeCount).toBe(3);
    expect(unlinked).toBe(true);
    expect(d.lines).toEqual(['stopped kaprek (pid 111)']);
  });

  it('port never frees within 2 s: still deletes the lock and reports stopped (best-effort, not a hang)', async () => {
    const d = deps({ isAlive: async () => true });
    expect(await runStopCommand([], d.deps)).toBe(0);
    expect(d.lines).toEqual(['stopped kaprek (pid 111)']);
  });

  it('no url on the lock: falls back to probing the pid instead of the port', async () => {
    let probeCount = 0;
    const d = deps({
      readLock: () => ({ pid: 111, url: null }),
      kill: (pid, signal) => {
        if (signal === 0) {
          probeCount += 1;
          if (probeCount > 2) {
            const err = new Error('ESRCH');
            err.code = 'ESRCH';
            throw err;
          }
        }
      },
      isAlive: async () => {
        throw new Error('should not be called without a url');
      },
    });
    expect(await runStopCommand([], d.deps)).toBe(0);
    expect(d.lines).toEqual(['stopped kaprek (pid 111)']);
    expect(probeCount).toBeGreaterThan(2);
  });

  it('kill(pid) itself throws: reports the error, exit 1, no lock deletion', async () => {
    let unlinked = false;
    const d = deps({
      kill: (pid, signal) => {
        if (signal === undefined) throw new Error('access denied');
      },
      unlink: () => {
        unlinked = true;
      },
    });
    expect(await runStopCommand([], d.deps)).toBe(1);
    expect(d.lines).toEqual(['ERR could not stop kaprek (pid 111): access denied']);
    expect(unlinked).toBe(false);
  });

  it('-h prints usage and exits 0', async () => {
    const d = deps();
    expect(await runStopCommand(['-h'], d.deps)).toBe(0);
    expect(d.lines).toEqual([STOP_USAGE]);
  });

  it('an unexpected argument is rejected', async () => {
    const d = deps();
    expect(await runStopCommand(['--bogus'], d.deps)).toBe(1);
    expect(d.lines[0]).toBe('ERR unknown argument: --bogus');
  });
});
