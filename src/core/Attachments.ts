/**
 * Картинка из буфера обмена → вложение в хранилище (как делает редактор Obsidian при вставке скриншота).
 */

import type { App, TFile } from "obsidian";
import { imageExtensionForMime, pastedImageFileName } from "./InboxEntries";

type FileManagerWithAttachments = App["fileManager"] & {
  /** С Obsidian 1.5.7: путь по настройкам «Папка для вложений», без повтора имён. */
  getAvailablePathForAttachment?: (filename: string, sourcePath?: string) => Promise<string>;
};

/** Свободный путь в корне хранилища: «name.png», «name 1.png», … (для Obsidian старше 1.5.7). */
function availableRootPath(app: App, filename: string): string {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  let candidate = filename;
  for (let i = 1; app.vault.getAbstractFileByPath(candidate); i++) candidate = `${base} ${i}${ext}`;
  return candidate;
}

/**
 * Сохранить картинку вложением и вернуть markdown для вставки в текст: «![[Pasted image ….png]]»
 * (или ссылку в формате markdown - по настройкам ссылок хранилища).
 * sourcePath - заметка, к которой относится вложение (от неё считается папка вложений и относительные ссылки).
 */
export async function saveImageAttachment(
  app: App,
  image: Blob,
  sourcePath: string,
  now: Date = new Date()
): Promise<string> {
  const extension = imageExtensionForMime(image.type) ?? "png";
  const filename = pastedImageFileName(now, extension);
  const fileManager = app.fileManager as FileManagerWithAttachments;
  const path =
    typeof fileManager.getAvailablePathForAttachment === "function"
      ? await fileManager.getAvailablePathForAttachment(filename, sourcePath)
      : availableRootPath(app, filename);
  const file: TFile = await app.vault.createBinary(path, await image.arrayBuffer());
  return "!" + app.fileManager.generateMarkdownLink(file, sourcePath);
}
