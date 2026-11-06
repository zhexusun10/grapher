export interface PiExtension {
  id: string;
  name: string;
  source: string;
  path: string;
  enabled: boolean;
  bundled: boolean;
  required: boolean;
}
export interface ExtensionCatalog { globalDirectory: string; extensions: PiExtension[] }
async function call(operation: string, fields: Record<string, unknown> = {}): Promise<ExtensionCatalog> {
  const response = await fetch('/api/pi_extensions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ version: 1, operation, ...fields }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error || 'Pi extension operation failed');
  return body.result;
}
// Settings unmounts while it is closed, so every reopen started from a one-line
// "reading extensions" placeholder and only then built the real rows. That late
// height change moved the Settings pane under a reader who had already scrolled
// to the bottom: the pane stopped at the shorter content edge and was corrected
// once the rows landed. Remember the page-session catalog instead (the way the
// provider card already does) so a reopen paints the final rows immediately and
// refreshes behind them without changing the pane's height.
let cachedCatalog: ExtensionCatalog | null = null;
let inFlightCatalog: Promise<ExtensionCatalog> | null = null;

const remember = (catalog: ExtensionCatalog) => {
  cachedCatalog = catalog;
  return catalog;
};

export const piExtensions = {
  getCachedCatalog: () => cachedCatalog,
  // `refresh` bypasses the page-session catalog; the refresh control and a mount
  // that already had cached rows use it to pick up edits made outside Grapher.
  catalog: (refresh = false): Promise<ExtensionCatalog> => {
    if (!refresh && cachedCatalog) return Promise.resolve(cachedCatalog);
    if (inFlightCatalog) return inFlightCatalog;
    inFlightCatalog = call('catalog').then(remember).finally(() => { inFlightCatalog = null; });
    return inFlightCatalog;
  },
  setEnabled: (id: string, enabled: boolean) => call('set_enabled', { id, enabled }).then(remember),
};
