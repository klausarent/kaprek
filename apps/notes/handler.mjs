// Handler for notes.write (see app.json). Handlers may only write through
// ctx.workspaceDir via src/workspace/fs.mjs — see that module for the
// traversal/symlink hardening this relies on.
import { writeFile } from '../../src/workspace/fs.mjs';

/** Turns an arbitrary title into a safe filename fragment: lowercase, alnum/dash only, never empty. A title crafted to look like a path (e.g. "../../evil") is neutralized here, not merely rejected — the fs.mjs guard is the second line of defense. */
function slugify(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'note';
}

export async function handler(args, ctx) {
  const title = typeof args?.title === 'string' ? args.title : '';
  const content = typeof args?.content === 'string' ? args.content : '';
  if (title.trim().length === 0) throw new Error('notes.write requires a non-empty title');

  const relPath = `notes/${slugify(title)}-${Date.now()}.md`;
  const body = `# ${title}\n\n${content}\n`;
  writeFile({ workspaceDir: ctx.workspaceDir, relPath, data: body });
  return { relPath };
}
