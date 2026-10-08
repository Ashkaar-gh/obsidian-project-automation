import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { TFile } from "obsidian";
import {
  imageLinkPathOf,
  imageMimeForPath,
  loadImageBytes,
  resolveImageFile,
  sniffImageMime,
  toPngBytes,
  writePngToClipboard,
} from "../src/core/ImageClipboard";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const document = dom.window.document;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).buffer;
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]).buffer;

function imageIn(html: string): HTMLImageElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  return wrap.querySelector("img")!;
}

test("image clipboard: link path comes from the embed src, from an app:// resource name, and not from external URLs", () => {
  const embedded = imageIn(
    '<span class="internal-embed image-embed" src="Pasted image 20260819103255.png" alt="Pasted image 20260819103255.png|828"><img src="app://obsidian.md/x/Pasted%20image%2020260819103255.png?1" alt="Pasted image 20260819103255.png|828" width="828"></span>'
  );
  assert.equal(imageLinkPathOf(embedded), "Pasted image 20260819103255.png");
  const withAnchor = imageIn('<span class="internal-embed" src="dir/pic.png#heading|200"><img src="app://x/pic.png"></span>');
  assert.equal(imageLinkPathOf(withAnchor), "dir/pic.png");
  const bare = imageIn('<p><img src="app://obsidian.md/vault/attachments/Screen%20Shot.jpg?123"></p>');
  assert.equal(imageLinkPathOf(bare), "Screen Shot.jpg");
  const external = imageIn('<p><img src="https://example.com/a/b.png"></p>');
  assert.equal(imageLinkPathOf(external), null);
});

test("image clipboard: MIME by signature beats the extension; unknown bytes fall back to the extension", () => {
  assert.equal(sniffImageMime(PNG_BYTES), "image/png");
  assert.equal(sniffImageMime(JPEG_BYTES), "image/jpeg");
  assert.equal(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer), "image/gif");
  assert.equal(sniffImageMime(new Uint8Array([1, 2, 3, 4]).buffer), null);
  assert.equal(imageMimeForPath("a/b/Pasted image.PNG"), "image/png");
  assert.equal(imageMimeForPath("diagram.svg?x=1"), "image/svg+xml");
  assert.equal(imageMimeForPath("noext"), null);
});

test("image clipboard: vault file is resolved from the daily note and read as binary; PNG needs no re-encoding", async () => {
  const file = new TFile("attachments/shot.png");
  const app = {
    metadataCache: {
      getFirstLinkpathDest: (link: string, source: string) => (link === "shot.png" && source === "periodic/daily/01-09-2026.md" ? file : null),
    },
    vault: { readBinary: async (f: TFile) => (f === file ? PNG_BYTES : new ArrayBuffer(0)) },
  } as any;
  const img = imageIn('<span class="internal-embed image-embed" src="shot.png" alt="shot.png|300"><img src="app://x/shot.png" width="300"></span>');
  assert.equal(resolveImageFile(app, img, "periodic/daily/01-09-2026.md"), file);
  assert.equal(resolveImageFile(app, img, "other.md"), null);
  const loaded = await loadImageBytes(app, img, "periodic/daily/01-09-2026.md");
  assert.deepEqual(loaded, { bytes: PNG_BYTES, mime: "image/png" });
  assert.equal(await toPngBytes(PNG_BYTES, "image/png", document), PNG_BYTES);
});

test("image clipboard: Electron clipboard is preferred, Web Clipboard API is the fallback", async () => {
  const written: unknown[] = [];
  const electronWin = {
    require: (name: string) =>
      name === "electron"
        ? {
            nativeImage: { createFromBuffer: (buffer: Uint8Array) => ({ isEmpty: () => buffer.length === 0, buffer }) },
            clipboard: { writeImage: (image: unknown) => written.push(image) },
          }
        : null,
    navigator: { clipboard: { write: async () => { throw new Error("must not be used"); } } },
  } as unknown as Window;
  assert.equal(await writePngToClipboard(PNG_BYTES, electronWin), true);
  assert.equal(written.length, 1);
  assert.equal((written[0] as { buffer: Uint8Array }).buffer.length, 12);

  const items: Array<Record<string, Blob>> = [];
  class FakeClipboardItem {
    constructor(public parts: Record<string, Blob>) {
      items.push(parts);
    }
  }
  const webWin = {
    navigator: { clipboard: { write: async (list: unknown[]) => { assert.equal(list.length, 1); } } },
    ClipboardItem: FakeClipboardItem,
    Blob: dom.window.Blob,
  } as unknown as Window;
  assert.equal(await writePngToClipboard(PNG_BYTES, webWin), true);
  assert.equal(items.length, 1);
  assert.equal(items[0]["image/png"].type, "image/png");
  assert.equal(items[0]["image/png"].size, 12);

  // Ни Electron, ни ClipboardItem - честный false (вызывающий код покажет уведомление об ошибке)
  const bareWin = { navigator: { clipboard: { writeText: async () => undefined } } } as unknown as Window;
  assert.equal(await writePngToClipboard(PNG_BYTES, bareWin), false);
});
