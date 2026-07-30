// Handler for notes.write (see app.json). Handlers may only write through
// ctx.workspace.writeFile() (see mcp-server.mjs's createWorkspaceCtx()),
// itself backed by src/workspace/fs.mjs — see that module for the
// traversal/symlink hardening this relies on. app.json declares
// `policy.fsWrite: true`, or ctx.workspace would have no writeFile at all.

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
  ctx.workspace.writeFile({ relPath, data: body });
  return { relPath };
}
