// `kaprek council "<question>"` — the second opinion from the terminal.
// Same machinery as the Council button in the web UI (server.mjs's
// /api/council/consult): peers read redacted snapshots, never the disk,
// and answer with a verdict. The result is printed and kept as a file.
import fs from 'node:fs';
import path from 'node:path';

export const COUNCIL_USAGE = `Usage: kaprek council "<question>" [--file <path>]... [--cwd <dir>] [--constraint <text>]... [--json]

  Asks the configured peers (codex, grok, …) blind and in parallel. Files are
  passed as redacted snapshots; secrets files are refused. Result is printed
  and saved under <dataDir>/council/cli/.
`;

function parse(argv) {
  const opts = { question: null, files: [], cwd: process.cwd(), constraints: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') opts.files.push(argv[++i]);
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--constraint') opts.constraints.push(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else if (opts.question === null) opts.question = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (typeof opts.question !== 'string' || opts.question.trim() === '') throw new Error('a question is required');
  if (opts.files.some((f) => typeof f !== 'string')) throw new Error('--file needs a path');
  if (typeof opts.cwd !== 'string' || opts.cwd === '') throw new Error('--cwd needs a directory');
  return opts;
}

function render(result, stdout) {
  for (const peerId of result.agreed) stdout(`${peerId.padEnd(8)} agree`);
  for (const d of result.dissenting) {
    stdout(`${d.peerId.padEnd(8)} ${d.verdict}${d.summary ? ` — ${d.summary}` : ''}`);
    for (const risk of d.risks ?? []) stdout(`         · ${risk}`);
  }
  for (const u of result.unreachable) stdout(`${u.peerId.padEnd(8)} unreachable${u.error ? ` — ${u.error}` : ''}`);
  if (result.empty) stdout('no peer answered');
  else stdout(result.consensus ? '\nconsensus: yes' : '\nconsensus: no');
}

export async function runCouncilCommand(argv, { dataDir, peersFor, snapshotFiles, consultPeers, stdout = (l) => console.log(l), stderr = (l) => console.error(l) }) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    stderr(err.message);
    stderr(COUNCIL_USAGE);
    return 1;
  }
  let status, cwd, snapshots, refused, result;
  try {
    status = peersFor();
    if (!status.possible) {
      stderr(`no council possible: ${status.reason ?? 'no second engine'}`);
      return 2;
    }
    cwd = path.resolve(opts.cwd);
    const files = opts.files.map((f) => path.resolve(cwd, f));
    ({ snapshots, refused } = snapshotFiles(files, { cwd, roots: [cwd] }));
    result = await consultPeers({ peers: status.peers, question: opts.question, snapshots, refused, constraints: opts.constraints, tried: [] });
  } catch (err) {
    stderr(`council failed: ${err.message}`);
    return 1;
  }
  const record = { ts: new Date().toISOString(), question: opts.question, files: opts.files, cwd, peers: status.peers, refused, result };
  try {
    const dir = path.join(dataDir, 'council', 'cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${record.ts.replace(/[:.]/g, '-')}.json`), JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    stderr(`could not save the consultation: ${err.message}`);
  }
  if (opts.json) {
    stdout(JSON.stringify(result));
    return 0;
  }
  if (refused.length > 0) stdout(`refused (secrets or outside cwd): ${refused.map((r) => r.path ?? r).join(', ')}`);
  render(result, stdout);
  return 0;
}
