function normalizeSafeRelativePath(raw: string): string | undefined {
  let path: string;
  try { path = decodeURIComponent(raw).replace(/\\/g, "/"); }
  catch { return; }
  if (path.startsWith("./")) path = path.slice(2);
  if (!path || /[:\x00-\x1f\x7f]/.test(path) || path.split("/").some(part =>
    !part || part === "." || part === ".." || /^(?:\.git|\.grapher)$/i.test(part))) return;
  return path;
}

/** A model's local image target is a workspace-relative path (including `.tmp/`)
 * or a file inside `/tmp/`, never an arbitrary filesystem path or app URL. */
export function workspaceImagePath(source: string): string | undefined {
  if (!source) return;
  const clean = source.split(/[?#]/, 1)[0];
  const withoutFileScheme = /^file:\/\//i.test(clean) ? clean.slice("file://".length) : clean;
  const tempPrefix = withoutFileScheme.startsWith("/tmp/")
    ? "/tmp/"
    : withoutFileScheme.startsWith("/private/tmp/")
      ? "/private/tmp/"
      : undefined;
  if (tempPrefix) {
    const relative = normalizeSafeRelativePath(withoutFileScheme.slice(tempPrefix.length));
    return relative ? `/tmp/${relative}` : undefined;
  }
  if (/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/i.test(source)) return;
  return normalizeSafeRelativePath(clean);
}
