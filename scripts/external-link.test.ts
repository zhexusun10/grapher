import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  installDesktopExternalLinkHandler,
  openExternalUrl,
  resolveExternalHttpUrl,
  copyTextToClipboard,
} from '../src/services/externalLink.ts';

function withDesktopGlobal<T>(
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null,
  fn: () => Promise<T> | T,
): Promise<T> {
  const host = globalThis as Record<string, unknown>;
  const hadIsTauri = 'isTauri' in host;
  const hadInternals = '__TAURI_INTERNALS__' in host;
  const prevIsTauri = host.isTauri;
  const prevInternals = host.__TAURI_INTERNALS__;
  if (invoke) {
    host.isTauri = true;
    host.__TAURI_INTERNALS__ = { invoke };
  } else {
    delete host.isTauri;
    delete host.__TAURI_INTERNALS__;
  }
  return Promise.resolve().then(fn).finally(() => {
    if (hadIsTauri) host.isTauri = prevIsTauri;
    else delete host.isTauri;
    if (hadInternals) host.__TAURI_INTERNALS__ = prevInternals;
    else delete host.__TAURI_INTERNALS__;
  });
}

test('resolveExternalHttpUrl accepts only http/https URLs and rejects anchors or unsafe schemes', () => {
  assert.equal(
    resolveExternalHttpUrl('https://github.com/zhexusun10/grapher/releases'),
    'https://github.com/zhexusun10/grapher/releases',
  );
  assert.equal(
    resolveExternalHttpUrl('http://example.com/path?a=1&b=2'),
    'http://example.com/path?a=1&b=2',
  );
  assert.equal(resolveExternalHttpUrl(''), null);
  assert.equal(resolveExternalHttpUrl('#section'), null);
  assert.equal(resolveExternalHttpUrl('javascript:alert(1)'), null);
  assert.equal(resolveExternalHttpUrl('file:///etc/passwd'), null);
  assert.equal(resolveExternalHttpUrl('https://user:password@example.com/'), null);
  assert.equal(resolveExternalHttpUrl('mailto:test@example.com'), null);
});

test('copyTextToClipboard falls back to the document copy command inside a modal without losing focus', async () => {
  const host = globalThis as Record<string, unknown>;
  const originalDocument = host.document;
  const originalHTMLElement = host.HTMLElement;
  class FakeElement {
    value = '';
    selected = false;
    removed = false;
    focused = false;
    isConnected = true;
    tabIndex = 0;
    style: Record<string, string> = {};
    children: FakeElement[] = [];
    dialog: FakeElement | null = null;
    setAttribute() {}
    appendChild(child: FakeElement) { this.children.push(child); }
    closest(selector: string) { return selector.includes('dialog') ? this.dialog : null; }
    select() { this.selected = true; }
    focus() { this.focused = true; }
    remove() { this.removed = true; this.isConnected = false; }
  }
  const dialog = new FakeElement();
  const trigger = new FakeElement();
  trigger.dialog = dialog;
  const body = new FakeElement();
  let created: FakeElement | null = null;
  host.HTMLElement = FakeElement;
  host.document = {
    body,
    activeElement: trigger,
    createElement() {
      created = new FakeElement();
      return created;
    },
    execCommand(command: string) {
      return command === 'copy'
        && dialog.children.includes(created!)
        && body.children.length === 0
        && Boolean(created?.selected)
        && created?.value === 'https://auth.example/login';
    },
  };
  try {
    assert.equal(await copyTextToClipboard('https://auth.example/login'), true);
    assert.equal(created?.removed, true, 'the temporary copy field is removed');
    assert.equal(trigger.focused, true, 'focus returns to the modal trigger after copying');
  } finally {
    if (originalDocument === undefined) delete host.document;
    else host.document = originalDocument;
    if (originalHTMLElement === undefined) delete host.HTMLElement;
    else host.HTMLElement = originalHTMLElement;
  }
});

test('openExternalUrl delegates to open_external_url IPC command in Tauri desktop mode', async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  await withDesktopGlobal(async (cmd, args) => {
    calls.push({ cmd, args });
  }, async () => {
    const ok = await openExternalUrl('https://github.com/zhexusun10/grapher/releases');
    assert.equal(ok, true);
    assert.deepEqual(calls, [{
      cmd: 'open_external_url',
      args: { url: 'https://github.com/zhexusun10/grapher/releases' },
    }]);
    assert.equal(await openExternalUrl('file:///etc/passwd'), false);
    assert.equal(calls.length, 1);
  });
});

test('installDesktopExternalLinkHandler intercepts external anchor clicks only in Tauri desktop mode', async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const fakeDoc = {
    location: { href: 'http://tauri.localhost/', origin: 'http://tauri.localhost' },
    addEventListener(type: string, fn: (event: unknown) => void) { listeners.set(type, fn); },
    removeEventListener(type: string) { listeners.delete(type); },
  } as unknown as Document;

  // Browser mode installs no listener.
  await withDesktopGlobal(null, () => {
    const cleanup = installDesktopExternalLinkHandler(fakeDoc);
    assert.equal(listeners.size, 0);
    cleanup();
  });

  await withDesktopGlobal(async (cmd, args) => {
    calls.push({ cmd, args });
  }, async () => {
    const cleanup = installDesktopExternalLinkHandler(fakeDoc);
    const onClick = listeners.get('click');
    assert.ok(onClick, 'click handler should be registered in desktop mode');

    let prevented = false;
    const anchor = {
      target: '_blank',
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === 'href' ? 'https://github.com/zhexusun10/grapher/releases' : null),
      closest: () => anchor,
    };
    onClick({
      defaultPrevented: false,
      button: 0,
      target: { parentElement: anchor },
      preventDefault() { prevented = true; },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(prevented, true);
    assert.deepEqual(calls, [{
      cmd: 'open_external_url',
      args: { url: 'https://github.com/zhexusun10/grapher/releases' },
    }]);

    // Same-origin internal link without _blank is left untouched.
    let internalPrevented = false;
    const internalAnchor = {
      target: '',
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === 'href' ? '/internal' : null),
      closest: () => internalAnchor,
    };
    onClick({
      defaultPrevented: false,
      button: 0,
      target: { parentElement: internalAnchor },
      preventDefault() { internalPrevented = true; },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(internalPrevented, false);
    assert.equal(calls.length, 1);

    let modifiedPrevented = false;
    onClick({
      defaultPrevented: false,
      button: 0,
      ctrlKey: true,
      target: { parentElement: anchor },
      preventDefault() { modifiedPrevented = true; },
    });
    assert.equal(modifiedPrevented, false, 'modified clicks keep native browser behavior');

    cleanup();
    assert.equal(listeners.size, 0);

    // Opaque `"null"` origin (e.g. WebKit custom scheme) still intercepts
    // external HTTP(S) links even when target="_blank" is omitted.
    const opaqueDoc = {
      location: { href: 'tauri://localhost/index.html', origin: 'null' },
      addEventListener(type: string, fn: (event: unknown) => void) { listeners.set(type, fn); },
      removeEventListener(type: string) { listeners.delete(type); },
    } as unknown as Document;
    const cleanupOpaque = installDesktopExternalLinkHandler(opaqueDoc);
    const onOpaqueClick = listeners.get('click')!;
    let opaquePrevented = false;
    const externalAnchor = {
      target: '',
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === 'href' ? 'https://example.com/docs' : null),
      closest: () => externalAnchor,
    };
    onOpaqueClick({
      defaultPrevented: false,
      button: 0,
      target: { parentElement: externalAnchor },
      preventDefault() { opaquePrevented = true; },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(opaquePrevented, true);
    assert.deepEqual(calls.at(-1), {
      cmd: 'open_external_url',
      args: { url: 'https://example.com/docs' },
    });
    cleanupOpaque();
  });
});
