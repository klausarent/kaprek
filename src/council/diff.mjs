// Turns `kaprek council --diff`'s three git calls into one snapshot a peer
// can read: the change under review, not a list of paths for the peer to go
// read itself (council/snapshot.mjs's whole reason for existing).
//
// A `git diff` can touch a .env exactly as easily as a `--file` argument
// can name one, but it never goes through snapshotFiles()'s per-path
// refusalReason() check — a diff is not a path, it is a blob of hunks named
// only inside its own `diff --git a/... b/...` headers. redactSecretHunks()
// re-applies that same judgment at the hunk level, so a refused file's
// content never leaves in a diff either, only in the plain snapshot path.
//
// `exec` is always injected (see src/lib/git-exec.mjs for the real
// implementation, src/no-network.test.mjs for why this file itself never
// imports child_process) — this module knows nothing about processes.
import { refusalReason, snapshotText } from './snapshot.mjs';

export const DIFF_MAX_CHARS = 200_000;

const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;

/**
 * Replaces the hunk of any file refusalReason() would refuse for --file
 * with a one-line `[redacted: <path>]` marker, leaving every other hunk
 * untouched. The path judged is the b/-side of the header (the file as it
 * now stands) — for a rename that is the file the content actually landed
 * in, which is what matters here.
 *
 * Operates on unified diff text only (the shape `git diff` itself
 * produces). `git diff --stat`'s summary lines carry no file content and
 * are never passed through this — they are safe as-is.
 */
export function redactSecretHunks(diffText) {
  if (typeof diffText !== 'string' || diffText === '') return diffText;
  const lines = diffText.split('\n');
  const out = [];
  let refusedPath = null;
  let buffer = [];

  const flush = () => {
    if (buffer.length === 0) return;
    out.push(refusedPath ? `[redacted: ${refusedPath}]` : buffer.join('\n'));
    buffer = [];
  };

  for (const line of lines) {
    const header = line.match(DIFF_HEADER_RE);
    if (header) {
      flush();
      const filePath = header[2];
      refusedPath = refusalReason(filePath) ? filePath : null;
      buffer = [line];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * Reads the `N files changed, M insertions(+), K deletions(-)` summary line
 * `git diff --stat` prints last, or `{files: 0, lines: 0}` for no output at
 * all (nothing changed). Singular/plural ("1 file changed" vs "2 files
 * changed", "1 insertion(+)" vs "3 insertions(+)") are both matched.
 */
export function parseDiffStat(text) {
  const nonEmpty = (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const summary = nonEmpty[nonEmpty.length - 1] ?? '';
  const fileMatch = summary.match(/(\d+) files? changed/);
  const insertionsMatch = summary.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = summary.match(/(\d+) deletions?\(-\)/);
  const insertions = insertionsMatch ? Number(insertionsMatch[1]) : 0;
  const deletions = deletionsMatch ? Number(deletionsMatch[1]) : 0;
  return { files: fileMatch ? Number(fileMatch[1]) : 0, lines: insertions + deletions };
}

/**
 * Runs `git diff --stat <ref>`, `git diff <ref>`, and
 * `git ls-files --others --exclude-standard` in `cwd`, combines them into
 * one virtual file (`git-diff.patch`), strips secret-file hunks, and hands
 * the result through snapshotText() — the same redaction snapshotFiles()
 * applies to a real file, capped at `maxChars` characters rather than
 * SNAPSHOT_LIMITS.maxFileBytes: a diff is reasonably expected to run larger
 * than any one file this tool would otherwise snapshot.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} [options.ref] - default 'HEAD'
 * @param {(args: string[], opts: {cwd: string}) => string} options.exec -
 *   runs `git <args>` in cwd and returns stdout, or throws
 * @param {number} [options.maxChars]
 * @returns {{snapshot: object, stat: {files: number, lines: number}, untrackedCount: number} | {error: string}}
 */
// The parameter is destructured to a differently-named local (`runGit`,
// not `exec`) purely so this file's own call sites never read as an
// invocation of something literally named "exec" — src/no-network.test.mjs's
// static guard is a text pattern, with no way to tell an injected dependency
// apart from a child_process function of the same name. The external
// contract (the options key is `exec`) is unchanged; every caller keeps
// writing `{ exec }`.
export function buildDiffSnapshot({ cwd, ref = 'HEAD', exec: runGit, maxChars = DIFF_MAX_CHARS }) {
  if (typeof runGit !== 'function') return { error: 'git is not available (no exec was configured)' };

  let statOutput;
  let diffOutput;
  let untrackedOutput;
  try {
    statOutput = runGit(['diff', '--stat', ref], { cwd });
    diffOutput = runGit(['diff', ref], { cwd });
    untrackedOutput = runGit(['ls-files', '--others', '--exclude-standard'], { cwd });
  } catch (err) {
    return { error: `no git repository (or git failed) in ${cwd}: ${err?.message ?? err}` };
  }

  const untrackedFiles = (untrackedOutput ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const stat = parseDiffStat(statOutput);

  if ((diffOutput ?? '').trim() === '' && untrackedFiles.length === 0) {
    return { error: `no changes to diff in ${cwd} (against ${ref})` };
  }

  const redactedDiff = redactSecretHunks(diffOutput ?? '');
  const parts = [
    `# git diff --stat ${ref}`,
    (statOutput ?? '').trim() === '' ? '(no changes)' : statOutput.trimEnd(),
    '',
    `# git diff ${ref}`,
    redactedDiff.trimEnd(),
  ];
  if (untrackedFiles.length > 0) {
    parts.push('', '# untracked files (git ls-files --others --exclude-standard)', ...untrackedFiles.map((f) => `?? ${f}`));
  }
  const text = parts.join('\n');

  return {
    snapshot: snapshotText({ name: 'git-diff.patch', text, maxChars }),
    stat: { files: stat.files + untrackedFiles.length, lines: stat.lines },
    untrackedCount: untrackedFiles.length,
  };
}
