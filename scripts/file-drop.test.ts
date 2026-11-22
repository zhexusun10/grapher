import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractDroppedFiles,
  getFirstDroppedFile,
  hasDraggedFiles,
  installWindowFileDropGuard,
} from '../src/utils/fileDrop.ts';
import { ComposerDrafts } from '../src/services/composerDrafts.ts';
import {
  computeScaledDimensions,
  extractBase64FromDataUrl,
  prepareVisionImageAttachment,
} from '../src/utils/imageCompress.ts';

test('hasDraggedFiles detects Files type, file items, and FileList entries while ignoring text drags', () => {
  assert.equal(hasDraggedFiles(null), false);
  assert.equal(hasDraggedFiles(undefined), false);
  assert.equal(hasDraggedFiles({ types: ['text/plain', 'text/html'] }), false);
  assert.equal(hasDraggedFiles({ types: ['Files'] }), true);
  // Array-like DOMStringList compatibility (WebKit)
  assert.equal(hasDraggedFiles({ types: { 0: 'public.file-url', 1: 'Files', length: 2 } }), true);
  assert.equal(hasDraggedFiles({ types: [], items: [{ kind: 'string' }] }), false);
  assert.equal(hasDraggedFiles({ types: [], items: [{ kind: 'file' }] }), true);
  const fakeFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  assert.equal(hasDraggedFiles({ types: [], files: [fakeFile] }), true);
});

test('getFirstDroppedFile prefers dataTransfer.files and falls back to file DataTransferItems', () => {
  const fileA = new File(['a'], 'a.png', { type: 'image/png' });
  const fileB = new File(['b'], 'b.txt', { type: 'text/plain' });
  assert.equal(getFirstDroppedFile(null), null);
  assert.equal(getFirstDroppedFile({ files: [fileA, fileB] }), fileA);
  assert.equal(
    getFirstDroppedFile({
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => fileB },
      ],
    }),
    fileB,
  );
  assert.equal(
    getFirstDroppedFile({
      files: [],
      items: [{ kind: 'string', getAsFile: () => fileA }],
    }),
    null,
  );

  // Directory entries are skipped and reported separately while multiple files are preserved.
  const folderStub = new File([], 'folder');
  const extracted = extractDroppedFiles({
    files: [folderStub, fileA, fileB],
    items: [
      { kind: 'file', getAsFile: () => folderStub, webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: 'file', getAsFile: () => fileA, webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) },
      { kind: 'file', getAsFile: () => fileB, webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) },
    ],
  });
  assert.equal(extracted.skippedDirectories, 1);
  assert.deepEqual(extracted.files, [fileA, fileB]);
});

test('installWindowFileDropGuard prevents default file navigation outside drop zones without blocking handled or text drags', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const fakeWindow = {
    addEventListener(type: string, fn: (event: unknown) => void) {
      listeners.set(type, fn);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
  };

  const cleanup = installWindowFileDropGuard(fakeWindow as unknown as Window);
  assert.ok(listeners.has('dragover'));
  assert.ok(listeners.has('drop'));

  // Unhandled file dragover outside composer: prevented and dropEffect set to none.
  const fileDragOver = {
    defaultPrevented: false,
    dataTransfer: { types: ['Files'], dropEffect: 'copy' as DataTransfer['dropEffect'] },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  listeners.get('dragover')!(fileDragOver);
  assert.equal(fileDragOver.defaultPrevented, true);
  assert.equal(fileDragOver.dataTransfer.dropEffect, 'none');

  // Unhandled file drop outside composer: prevented so WebView does not navigate.
  const fileDrop = {
    defaultPrevented: false,
    dataTransfer: { types: ['Files'] },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  listeners.get('drop')!(fileDrop);
  assert.equal(fileDrop.defaultPrevented, true);

  // Already-handled composer dragover: left untouched (keeps dropEffect = copy).
  const handledDragOver = {
    defaultPrevented: true,
    dataTransfer: { types: ['Files'], dropEffect: 'copy' as DataTransfer['dropEffect'] },
    preventDefault() {
      throw new Error('should not call preventDefault again');
    },
  };
  listeners.get('dragover')!(handledDragOver);
  assert.equal(handledDragOver.dataTransfer.dropEffect, 'copy');

  // Plain text drag: ignored so text selection dragging still works.
  const textDragOver = {
    defaultPrevented: false,
    dataTransfer: { types: ['text/plain'], dropEffect: 'move' as DataTransfer['dropEffect'] },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  listeners.get('dragover')!(textDragOver);
  assert.equal(textDragOver.defaultPrevented, false);
  assert.equal(textDragOver.dataTransfer.dropEffect, 'move');

  cleanup();
  assert.equal(listeners.size, 0);
});

test('ComposerDrafts persists attachments per draft key across composer unmounts and notifies subscribers', () => {
  const drafts = new ComposerDrafts();
  let notifications = 0;
  const unsubscribe = drafts.subscribe(() => {
    notifications += 1;
  });

  const fileA = new File(['png-bytes'], 'diagram.png', { type: 'image/png' });
  const fileB = new File(['pdf-bytes'], 'spec.pdf', { type: 'application/pdf' });
  const attachmentA = { file: fileA, imagePreview: 'data:image/png;base64,cG5n', attachmentId: 'att-a' };
  const attachmentB = { file: fileB, imagePreview: null, attachmentId: 'att-b' };

  assert.equal(drafts.attachment('repo-a'), null);

  // Clearing an absent attachment does not fire spurious notifications.
  drafts.clearAttachment('repo-a');
  assert.equal(notifications, 0);

  drafts.setAttachment('repo-a', attachmentA);
  drafts.setAttachment('repo-b', attachmentB);
  assert.equal(notifications, 2);
  assert.equal(drafts.attachment('repo-a'), attachmentA);
  assert.equal(drafts.attachment('repo-b'), attachmentB);

  drafts.clearAttachment('repo-a');
  assert.equal(notifications, 3);
  assert.equal(drafts.attachment('repo-a'), null);
  assert.equal(drafts.attachment('repo-b'), attachmentB);

  unsubscribe();
  drafts.clearAttachment('repo-b');
  assert.equal(notifications, 3);
  assert.equal(drafts.attachment('repo-b'), null);

  // Multi-attachment add/update/move/remove lifecycle.
  drafts.addAttachments('unbound', [attachmentA, attachmentB]);
  assert.equal(drafts.attachments('unbound').length, 2);
  drafts.updateAttachment('unbound', 'att-b', { uploadedPath: '/data/attachment-inputs/id/spec.pdf' });
  assert.equal(drafts.attachments('unbound')[1].uploadedPath, '/data/attachment-inputs/id/spec.pdf');
  drafts.moveAttachments('unbound', 'bound');
  assert.equal(drafts.attachments('unbound').length, 0);
  assert.equal(drafts.attachments('bound').length, 2);
  const removed = drafts.removeAttachment('bound', 'att-b');
  assert.equal(removed?.uploadedPath, '/data/attachment-inputs/id/spec.pdf');
  assert.deepEqual(drafts.attachments('bound'), [attachmentA]);
});

test('computeScaledDimensions scales oversized images proportionally and never upscales small ones', () => {
  assert.deepEqual(computeScaledDimensions(800, 600, 2000, 2000), { width: 800, height: 600, scaled: false });
  assert.deepEqual(computeScaledDimensions(5120, 2880, 2000, 2000), { width: 2000, height: 1125, scaled: true });
  assert.deepEqual(computeScaledDimensions(1500, 3000, 2000, 2000), { width: 1000, height: 2000, scaled: true });
  assert.equal(extractBase64FromDataUrl('data:image/png;base64,QUJD'), 'QUJD');
  assert.equal(extractBase64FromDataUrl('QUJD'), 'QUJD');
});

test('prepareVisionImageAttachment preserves small images and compresses oversized ones below budget', async () => {
  const host = globalThis as Record<string, unknown>;
  const prevImage = host.Image;
  const prevDocument = host.document;

  const tinyFile = new File(['abc'], 'small.png', { type: 'image/png' });
  const tinyResult = await prepareVisionImageAttachment(
    tinyFile,
    'image/png',
    'data:image/png;base64,YWJj',
    { maxBase64Bytes: 100 },
  );
  assert.deepEqual(tinyResult, { mimeType: 'image/png', data: 'YWJj' });

  // Simulate an oversized 5K PNG whose raw base64 exceeds maxBase64Bytes,
  // verifying that canvas re-encoding draws once per scale, switches to JPEG
  // within budget, and releases the canvas backing store.
  const canvasCalls: Array<{ width: number; height: number; mimeType: string; quality?: number }> = [];
  let drawImageCalls = 0;
  let createdCanvases: Array<{ width: number; height: number }> = [];
  class FakeImage {
    naturalWidth = 5120;
    naturalHeight = 2880;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  const fakeDocument = {
    createElement(tag: string) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        getContext() {
          return {
            fillStyle: '',
            globalCompositeOperation: 'source-over',
            imageSmoothingEnabled: false,
            imageSmoothingQuality: 'low',
            fillRect() {},
            drawImage() {
              drawImageCalls += 1;
            },
          };
        },
        toDataURL(mimeType: string, quality?: number) {
          canvasCalls.push({ width: this.width, height: this.height, mimeType, quality });
          if (mimeType === 'image/png') {
            return `data:image/png;base64,${'P'.repeat(2000)}`;
          }
          const len = quality && quality <= 0.75 ? 400 : 1200;
          return `data:image/jpeg;base64,${'J'.repeat(len)}`;
        },
      };
      createdCanvases.push(canvas);
      return canvas;
    },
  };

  try {
    host.Image = FakeImage;
    host.document = fakeDocument;
    const hugeBase64 = 'X'.repeat(5000);
    const hugeFile = new File(['huge'], 'retina.png', { type: 'image/png' });
    const compressed = await prepareVisionImageAttachment(
      hugeFile,
      'image/png',
      `data:image/png;base64,${hugeBase64}`,
      { maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 800 },
    );
    assert.equal(compressed.mimeType, 'image/jpeg');
    assert.equal(compressed.data.length, 400);
    assert.equal(canvasCalls[0].width, 2000);
    assert.equal(canvasCalls[0].height, 1125);
    assert.equal(drawImageCalls, 1, 'must draw once per scale instead of redrawing for each quality');
    assert.equal(createdCanvases[0].width, 0, 'canvas backing store should be released after encoding');
    assert.equal(createdCanvases[0].height, 0);

    // When even the smallest encoded output still exceeds the byte budget, fail explicitly.
    await assert.rejects(
      () => prepareVisionImageAttachment(
        hugeFile,
        'image/png',
        `data:image/png;base64,${hugeBase64}`,
        { maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 100 },
      ),
      /maximum supported size/i,
    );
  } finally {
    if (prevImage === undefined) delete host.Image;
    else host.Image = prevImage;
    if (prevDocument === undefined) delete host.document;
    else host.document = prevDocument;
  }
});
