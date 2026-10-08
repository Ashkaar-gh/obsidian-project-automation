/**
 * Копирование картинки из превью записи в системный буфер обмена как изображения - а не ссылки
 * ![[...]], которая работает только внутри Obsidian. Картинка берётся из хранилища (readBinary) или
 * по внешнему URL, при необходимости перекодируется в PNG через canvas и кладётся в буфер:
 * на десктопе через Electron (нативные форматы - вставляется в мессенджеры, письма, редакторы),
 * иначе через Web Clipboard API.
 */

import { TFile, type App } from "obsidian";

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
  ico: "image/x-icon",
};

/** MIME по расширению пути картинки (null - расширение неизвестно). */
export function imageMimeForPath(path: string): string | null {
  const ext = path.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? null;
}

/** MIME по сигнатуре байтов (надёжнее расширения; null - не распознано). */
export function sniffImageMime(bytes: ArrayBuffer): string | null {
  const b = new Uint8Array(bytes.slice(0, 16));
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "image/webp";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  return null;
}

/** Имя файла из URL ресурса (app://…/Pasted%20image.png?123 → Pasted image.png). */
function fileNameFromUrl(url: string): string {
  try {
    const last = url.split("?")[0].split("#")[0].split("/").pop() ?? "";
    return decodeURIComponent(last).trim();
  } catch {
    return "";
  }
}

/**
 * Путь ссылки картинки в хранилище по элементу превью: у встраивания - атрибут src
 * (без якоря и размера), у <img> с ресурсом приложения (app://) - имя файла.
 * null - внешняя картинка (http/data) без файла в хранилище.
 */
export function imageLinkPathOf(img: HTMLImageElement): string | null {
  const embed = img.closest(".internal-embed");
  const embedSrc = (embed?.getAttribute("src") ?? "").trim();
  if (embedSrc) return embedSrc.split("#")[0].split("|")[0].trim() || null;
  const src = (img.getAttribute("src") ?? "").trim();
  if (/^app:/i.test(src)) return fileNameFromUrl(src) || null;
  return null;
}

/** Файл картинки в хранилище по элементу превью (null - внешняя картинка или файл не найден). */
export function resolveImageFile(app: App, img: HTMLImageElement, sourcePath: string): TFile | null {
  const linkPath = imageLinkPathOf(img);
  if (!linkPath) return null;
  const file = app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
  return file instanceof TFile ? file : null;
}

export interface LoadedImage {
  bytes: ArrayBuffer;
  mime: string;
}

/** Байты картинки: файл хранилища, иначе загрузка по URL (внешняя картинка). */
export async function loadImageBytes(app: App, img: HTMLImageElement, sourcePath: string): Promise<LoadedImage | null> {
  const file = resolveImageFile(app, img, sourcePath);
  if (file) {
    const bytes = await app.vault.readBinary(file);
    return { bytes, mime: sniffImageMime(bytes) ?? imageMimeForPath(file.path) ?? "application/octet-stream" };
  }
  const url = (img.currentSrc || img.getAttribute("src") || "").trim();
  if (!url) return null;
  try {
    const win = img.ownerDocument.defaultView ?? window;
    const response = await win.fetch(url);
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    const header = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    return { bytes, mime: sniffImageMime(bytes) ?? (header || imageMimeForPath(url) || "application/octet-stream") };
  } catch (error) {
    console.warn("[TaskView] image fetch failed:", error);
    return null;
  }
}

/** Размер по умолчанию для картинок без собственных размеров (SVG без width/height). */
export interface FallbackSize {
  width: number;
  height: number;
}

/**
 * PNG из байтов картинки: PNG отдаётся как есть, остальные форматы декодируются через <img>
 * (blob: того же происхождения - canvas не «портится») и перекодируются canvas'ом.
 */
export async function toPngBytes(
  bytes: ArrayBuffer,
  mime: string,
  doc: Document,
  fallbackSize: FallbackSize = { width: 1024, height: 768 }
): Promise<ArrayBuffer | null> {
  if (mime === "image/png") return bytes;
  const win = doc.defaultView;
  if (!win) return null;
  const BlobCtor = (win as unknown as { Blob: typeof Blob }).Blob;
  const blob = new BlobCtor([bytes], { type: mime });
  const url = win.URL.createObjectURL(blob);
  try {
    const image = doc.createElement("img");
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = url;
    });
    const canvas = doc.createElement("canvas");
    canvas.width = image.naturalWidth || fallbackSize.width;
    canvas.height = image.naturalHeight || fallbackSize.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return png ? await png.arrayBuffer() : null;
  } catch (error) {
    console.warn("[TaskView] image to PNG failed:", error);
    return null;
  } finally {
    win.URL.revokeObjectURL(url);
  }
}

type ElectronClipboard = {
  clipboard?: { writeImage(image: unknown): void };
  nativeImage?: { createFromBuffer(buffer: unknown): { isEmpty(): boolean } };
};

/**
 * Записать PNG в буфер обмена. Сначала Electron (как делает сам Obsidian: изображение в нативных
 * форматах буфера), затем Web Clipboard API (в т.ч. на мобильных). false - ни один способ недоступен.
 */
export async function writePngToClipboard(png: ArrayBuffer, win: Window): Promise<boolean> {
  try {
    const req = (win as unknown as { require?: (name: string) => ElectronClipboard }).require;
    const electron = typeof req === "function" ? req("electron") : null;
    const bufferCtor = (globalThis as unknown as { Buffer?: { from(data: Uint8Array): unknown } }).Buffer;
    if (electron?.clipboard && electron?.nativeImage && bufferCtor) {
      const image = electron.nativeImage.createFromBuffer(bufferCtor.from(new Uint8Array(png)));
      if (image && !image.isEmpty()) {
        electron.clipboard.writeImage(image);
        return true;
      }
    }
  } catch (error) {
    console.warn("[TaskView] electron clipboard failed, falling back to navigator.clipboard:", error);
  }
  const clipboard = win.navigator?.clipboard;
  const ItemCtor = (win as unknown as { ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem }).ClipboardItem;
  if (!clipboard || typeof clipboard.write !== "function" || typeof ItemCtor !== "function") return false;
  const BlobCtor = (win as unknown as { Blob: typeof Blob }).Blob;
  await clipboard.write([new ItemCtor({ "image/png": new BlobCtor([png], { type: "image/png" }) })]);
  return true;
}

/** Картинка превью → системный буфер обмена как изображение. false - не удалось. */
export async function copyImageToClipboard(app: App, img: HTMLImageElement, sourcePath: string): Promise<boolean> {
  const loaded = await loadImageBytes(app, img, sourcePath);
  if (!loaded) return false;
  const doc = img.ownerDocument;
  const win = doc.defaultView ?? window;
  const png = await toPngBytes(loaded.bytes, loaded.mime, doc, {
    width: img.naturalWidth || img.width || 1024,
    height: img.naturalHeight || img.height || 768,
  });
  if (!png) return false;
  return writePngToClipboard(png, win);
}
