import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { compareVersions, installKind, latestVersion, runInstall, updatePlan } from './update.mjs';

describe('installKind', () => {
  test('npx has nothing installed to update', () => {
    expect(installKind('C:/Users/someone/AppData/Local/npm-cache/_npx/abc123/node_modules/kaprek')).toBe('npx');
    expect(installKind('/home/someone/.npm/_npx/abc123/node_modules/kaprek')).toBe('npx');
  });

  test('a checkout is not a package', () => {
    expect(installKind('C:/Users/someone/Documents/Software/tools/ccview')).toBe('repo');
    expect(installKind('/home/someone/src/kaprek')).toBe('repo');
  });

  test('a global install on either platform', () => {
    expect(installKind('C:/Users/someone/AppData/Roaming/npm/node_modules/kaprek', {})).toBe('global');
    expect(installKind('/usr/local/lib/node_modules/kaprek', {})).toBe('global');
  });

  test('the npm prefix wins when it is set', () => {
    expect(installKind('/opt/tools/node_modules/kaprek', { npm_config_prefix: '/opt/tools' })).toBe('global');
  });

  test("someone else's dependency is local", () => {
    expect(installKind('/home/someone/projects/thing/node_modules/kaprek', {})).toBe('local');
  });
});

describe('compareVersions', () => {
  test('orders by each part, not by string', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0);
  });

  test('ignores a prerelease suffix rather than choking on it', () => {
    expect(compareVersions('0.5.0-rc.1', '0.5.0')).toBe(0);
  });

  test('a missing part counts as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0);
  });
});

describe('updatePlan', () => {
  test('up to date means nothing to do', () => {
    const plan = updatePlan({ kind: 'global', current: '0.5.0', latest: '0.5.0' });
    expect(plan.action).toBe('none');
    expect(plan.message).toMatch(/newest version/);
  });

  test('running something newer than npm has is said plainly, not treated as an error', () => {
    // The everyday case in the repo this is developed in.
    expect(updatePlan({ kind: 'repo', current: '0.6.0', latest: '0.5.0' }).message).toMatch(/newer than the published/);
  });

  test('a global install is the one case that installs', () => {
    const plan = updatePlan({ kind: 'global', current: '0.4.0', latest: '0.5.0' });
    expect(plan.action).toBe('install');
    expect(plan.command).toEqual(['npm', 'install', '-g', 'kaprek@latest']);
  });

  test('npx is told to use @latest rather than being updated', () => {
    const plan = updatePlan({ kind: 'npx', current: '0.4.0', latest: '0.5.0' });
    expect(plan.action).toBe('none');
    expect(plan.message).toMatch(/npx kaprek@latest/);
    // The trap worth naming: npx reuses its cache without it.
    expect(plan.message).toMatch(/cache/);
  });

  test('a checkout is told to pull, because npm would overwrite it', () => {
    const plan = updatePlan({ kind: 'repo', current: '0.4.0', latest: '0.5.0' });
    expect(plan.action).toBe('none');
    expect(plan.message).toMatch(/git pull/);
  });

  test("a project dependency is updated in that project, not globally", () => {
    const plan = updatePlan({ kind: 'local', current: '0.4.0', latest: '0.5.0' });
    expect(plan.action).toBe('none');
    expect(plan.message).toMatch(/npm i kaprek@latest/);
  });
});

describe('latestVersion', () => {
  /** A fake https.get that plays back one canned response. */
  function fakeGet({ statusCode = 200, body = '{"version":"9.9.9"}' } = {}) {
    return (url, options, callback) => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.setEncoding = () => {};
      res.resume = () => {};
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};
      queueMicrotask(() => {
        callback(res);
        res.emit('data', body);
        res.emit('end');
      });
      return req;
    };
  }

  test('reads the version out of the registry answer', async () => {
    await expect(latestVersion({ get: fakeGet() })).resolves.toBe('9.9.9');
  });

  test('a non-200 is an error with the status in it', async () => {
    await expect(latestVersion({ get: fakeGet({ statusCode: 503 }) })).rejects.toThrow(/503/);
  });

  test('an unreadable answer says so instead of resolving to undefined', async () => {
    await expect(latestVersion({ get: fakeGet({ body: 'not json' }) })).rejects.toThrow(/could not read/);
  });

  test('being offline is a plain message, not a stack trace', async () => {
    const get = () => {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      queueMicrotask(() => req.emit('error', new Error('getaddrinfo ENOTFOUND')));
      return req;
    };
    await expect(latestVersion({ get })).rejects.toThrow(/could not reach the npm registry/);
  });
});

describe('runInstall', () => {
  test('resolves with the exit code npm gave', async () => {
    const spawnFn = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    };
    await expect(runInstall(['npm', 'install', '-g', 'kaprek@latest'], { spawnFn })).resolves.toBe(0);
  });

  test('a missing npm is reported, not thrown', async () => {
    const spawnFn = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn npm ENOENT')));
      return child;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runInstall(['npm', 'install', '-g', 'kaprek@latest'], { spawnFn })).resolves.toBe(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
