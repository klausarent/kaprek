// Path containment, judged against the filesystem rather than the string.
//
// Lifted out of src/plans/store.mjs so the council's file snapshots and the
// plan store answer "is this path inside an allowed root?" with the same
// code. Two copies of a containment check is how one of them quietly stops
// resolving symlinks.
import fs from 'node:fs';
import path from 'node:path';

/**
 * The real path of `target`, with symlinks resolved as far as they exist.
 * A path that does not exist yet resolves its nearest existing ancestor and
 * appends the rest, so containment can be judged before creation too.
 */
export function realish(target) {
  let head = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(target);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Whether `target` sits inside `root`, judged AFTER resolving symlinks on
 * both sides.
 *
 * Codex' review: `path.resolve()` is purely lexical, so a junction or
 * symlink in any parent directory makes an "inside" path point anywhere on
 * the disk — and setStep() rewrites whatever it lands on. Resolving first is
 * what turns the containment check from a string comparison into a
 * filesystem one.
 */
export function isInside(root, target) {
  const a = realish(root);
  const b = realish(target);
  const [normA, normB] = process.platform === 'win32' ? [a.toLowerCase(), b.toLowerCase()] : [a, b];
  return normB === normA || normB.startsWith(normA.endsWith(path.sep) ? normA : `${normA}${path.sep}`);
}
