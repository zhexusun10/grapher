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
export const piExtensions = {
  catalog: () => call('catalog'),
  setEnabled: (id: string, enabled: boolean) => call('set_enabled', { id, enabled }),
};
