// Pure argv parser for the kaprek CLI. No I/O, no process.exit — bin/cli.mjs
// owns all side effects and decides how to react to what this returns/throws.
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 4900;

function defaultDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Parses CLI flags into { port, dir, redact, open, help }.
 * Throws an Error (with a caller-facing message) on invalid input.
 */
export function parseArgs(argv) {
  const result = {
    port: DEFAULT_PORT,
    dir: defaultDir(),
    redact: true,
    open: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--port': {
        const raw = argv[i + 1];
        i += 1;
        const port = Number(raw);
        if (raw === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid --port value: ${raw} (must be an integer between 1 and 65535)`);
        }
        result.port = port;
        break;
      }
      case '--dir': {
        const raw = argv[i + 1];
        if (raw === undefined) {
          throw new Error('--dir requires a path argument');
        }
        result.dir = raw;
        i += 1;
        break;
      }
      case '--no-redact':
        result.redact = false;
        break;
      case '--no-open':
        result.open = false;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}
