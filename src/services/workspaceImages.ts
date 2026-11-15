/** A model's relative image target is a workspace path, never an app URL. */
export function workspaceImagePath(source: string): string | undefined {
  if (!source || /^(?:[a-z][a-z\d+.-]*:|[/\\#?])/i.test(source)) return;
  let path: string;
  try { path = decodeURIComponent(source.split(/[?#]/, 1)[0]).replace(/\\/g, "/"); }
  catch { return; }
  if (path.startsWith("./")) path = path.slice(2);
  if (!path || /[:\x00-\x1f\x7f]/.test(path) || path.split("/").some(part =>
    !part || part === "." || part === ".." || /^(?:\.git|\.grapher)$/i.test(part))) return;
  return path;
}
