import { MarkdownView, type App, type TFile, type WorkspaceLeaf } from "obsidian";

/**
 * Открыть файл: если он уже открыт во вкладке - перейти в неё, иначе открыть в новой вкладке.
 * Нужно командам «Открыть или создать …»: иначе каждое нажатие хоткея открывало ещё одну вкладку того же файла.
 */
export async function openOrRevealFile(app: App, file: TFile): Promise<void> {
  const leaf = findLeafWithFile(app, file.path);
  if (leaf) {
    await app.workspace.revealLeaf(leaf);
    app.workspace.setActiveLeaf(leaf, { focus: true });
    return;
  }
  await app.workspace.getLeaf(true).openFile(file);
}

/** Вкладка markdown с этим файлом, в том числе ещё не загруженная (deferred view: файл виден только в состоянии). */
function findLeafWithFile(app: App, path: string): WorkspaceLeaf | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === path) return leaf;
    const state = leaf.getViewState().state as { file?: unknown } | undefined;
    if (typeof state?.file === "string" && state.file === path) return leaf;
  }
  return null;
}
