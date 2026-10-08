/**
 * Данные для привязки записей блокнота из хранилища: задачи (по frontmatter, как на доске), проект заметки,
 * контекст открытой заметки, подписи привязок. Логика поиска и порядка - в core/InboxLinks.
 */

import { TFile, type App, type MarkdownFileInfo } from "obsidian";
import { Paths } from "../core/Paths";
import { isProjectHubPage, isTaskNote } from "../core/TaskNote";
import type { InboxLink } from "../core/InboxEntries";
import {
  headingLinkTargetsAtLine,
  isSameProject,
  projectDisplayName,
  projectLinkTarget,
  taskProjectValues,
  type InboxLinkOption,
  type InboxProjectOption,
  type InboxTaskOption,
} from "../core/InboxLinks";

/** Даты записей задачи в ежедневных заметках (TaskIndex; в тестах может не быть). */
export interface TaskDatesSource {
  getDatesForTask(taskName: string, taskPath?: string): Date[];
}

type Frontmatter = Record<string, unknown>;

function frontmatterOf(app: App, file: TFile): Frontmatter | null {
  try {
    const cache = app.metadataCache?.getFileCache?.(file);
    return (cache?.frontmatter as Frontmatter | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Заметка-задача, как на доске: не шаблон, не корзина, не архив. */
function isBoardTask(app: App, file: TFile): boolean {
  const templatesPrefix = Paths.TEMPLATES_FOLDER.replace(/\/?$/, "") + "/";
  const archivePrefix = Paths.ARCHIVE_FOLDER.replace(/\/?$/, "") + "/";
  if (file.path.startsWith(templatesPrefix) || file.path.startsWith(archivePrefix) || file.path === Paths.TRASH_FILE) {
    return false;
  }
  const fm = frontmatterOf(app, file);
  return isTaskNote(file, fm ? { frontmatter: fm } : null);
}

/** Задача как вариант выбора; null - заметка не задача. */
export function taskOption(app: App, file: TFile, dates?: TaskDatesSource | null): InboxTaskOption | null {
  if (!isBoardTask(app, file)) return null;
  const fm = frontmatterOf(app, file) ?? {};
  const rawStatus = Array.isArray(fm.status) ? fm.status[0] : fm.status;
  let lastActivity = file.stat?.mtime ?? 0;
  try {
    for (const date of dates?.getDatesForTask(file.basename, file.path) ?? []) {
      lastActivity = Math.max(lastActivity, date.getTime());
    }
  } catch {
    // индекс ещё не готов - хватит времени правки заметки
  }
  return {
    kind: "task",
    path: file.path,
    name: file.basename,
    projects: taskProjectValues(fm.project),
    lastActivity,
    status: rawStatus == null ? "" : String(rawStatus).trim(),
  };
}

/** Все задачи хранилища (и активные, и завершённые). */
export function collectTaskOptions(app: App, dates?: TaskDatesSource | null): InboxTaskOption[] {
  const files: TFile[] = app.vault?.getMarkdownFiles?.() ?? [];
  const out: InboxTaskOption[] = [];
  for (const file of files) {
    const option = taskOption(app, file, dates);
    if (option) out.push(option);
  }
  return out;
}

/** Проекты, у которых есть своя заметка (frontmatter project совпадает с именем файла), - как во frontmatter. */
export function collectProjectNoteValues(app: App): string[] {
  const files: TFile[] = app.vault?.getMarkdownFiles?.() ?? [];
  const out: string[] = [];
  for (const file of files) {
    const option = projectOptionOfFile(app, file);
    if (option) out.push(option.project);
  }
  return out;
}

/** Заметка задачи по сохранённому пути; если её перенесли (имя то же) - по имени. */
export function resolveTaskFile(app: App, path: string): TFile | null {
  const direct = app.vault?.getAbstractFileByPath?.(path);
  if (direct instanceof TFile) return direct;
  const name = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  try {
    const found = app.metadataCache?.getFirstLinkpathDest?.(name, "");
    return found instanceof TFile ? found : null;
  } catch {
    return null;
  }
}

/** Проект заметки-проекта (frontmatter project совпадает с именем файла); null - не проект. */
function projectOptionOfFile(app: App, file: TFile): InboxProjectOption | null {
  const fm = frontmatterOf(app, file);
  if (!fm || !isProjectHubPage(file, fm)) return null;
  const project = taskProjectValues(fm.project).find(
    (value) => projectDisplayName(value).toLowerCase() === file.basename.toLowerCase()
  );
  return project ? { kind: "project", project, name: projectDisplayName(project) } : null;
}

/** Задача или проект по заметке: для контекста окна записи. */
function optionOfFile(app: App, file: TFile, dates?: TaskDatesSource | null): InboxLinkOption | null {
  return taskOption(app, file, dates) ?? projectOptionOfFile(app, file);
}

/**
 * К чему относится то, что сейчас открыто: заметка-задача; в другой заметке (ежедневной) - задача или проект
 * из заголовка со [[ссылкой]], под которым стоит курсор; заметка-проект. null - ничего определённого.
 */
export function contextLinkOption(app: App, dates?: TaskDatesSource | null): InboxLinkOption | null {
  try {
    const active = app.workspace?.activeEditor as (MarkdownFileInfo & { getMode?: () => string }) | null | undefined;
    const file = active?.file ?? (app.workspace?.getActiveFile?.() as TFile | null | undefined) ?? null;
    if (!(file instanceof TFile)) return null;
    const own = taskOption(app, file, dates);
    if (own) return own;
    const editor = active?.file === file && active.getMode?.() !== "preview" ? active.editor : null;
    if (editor) {
      const lines = editor.getValue().split("\n");
      const cursor = editor.getCursor("head").line;
      for (const target of headingLinkTargetsAtLine(lines, cursor)) {
        const dest = app.metadataCache?.getFirstLinkpathDest?.(target, file.path);
        if (!(dest instanceof TFile)) continue;
        const option = optionOfFile(app, dest, dates);
        if (option) return option;
      }
    }
    return projectOptionOfFile(app, file);
  } catch {
    return null;
  }
}

/** Ссылка на заметку для подписи: путь без .md; null - заметки нет (тогда подпись - просто текст). */
function noteHref(app: App, target: string): string | null {
  const clean = projectLinkTarget(target);
  if (!clean) return null;
  try {
    const dest = app.metadataCache?.getFirstLinkpathDest?.(clean, "");
    return dest instanceof TFile ? dest.path.replace(/\.md$/i, "") : null;
  } catch {
    return null;
  }
}

/** Привязка для показа под записью. */
export interface InboxLinkView {
  kind: "task" | "project";
  /** Имя задачи или проекта. */
  name: string;
  /** Ссылка на заметку задачи или проекта (data-href); null - заметки нет. */
  href: string | null;
  /** Проекты задачи: имя и ссылка на заметку проекта. */
  projects: Array<{ name: string; href: string | null }>;
}

/** Подпись задачи без проектов: имя и ссылка на её заметку. */
function bareTaskView(file: TFile): InboxLinkView {
  return { kind: "task", name: file.basename, href: file.path.replace(/\.md$/i, ""), projects: [] };
}

/** Подпись привязки: задача (с проектами из её frontmatter) или проект. null - привязки нет. */
export function describeInboxLink(app: App, link: InboxLink | null | undefined): InboxLinkView | null {
  if (link?.task) {
    const file = resolveTaskFile(app, link.task);
    if (!file) {
      const name = (link.task.split("/").pop() ?? link.task).replace(/\.md$/i, "");
      return { kind: "task", name, href: null, projects: [] };
    }
    const projects: InboxLinkView["projects"] = [];
    for (const value of taskProjects(app, file)) {
      const name = projectDisplayName(value);
      if (name && !projects.some((p) => p.name === name)) projects.push({ name, href: noteHref(app, value) });
    }
    return { ...bareTaskView(file), projects };
  }
  if (link?.project) {
    return { kind: "project", name: projectDisplayName(link.project), href: noteHref(app, link.project), projects: [] };
  }
  return null;
}

/**
 * Привязка записи как вариант поля «Относится к» (правка записи). Задача ищется и по имени (её могли перенести);
 * удалённая задача остаётся вариантом с прежним путём: правка текста записи её привязку не теряет.
 */
export function linkOptionFromLink(
  app: App,
  link: InboxLink | null | undefined,
  dates?: TaskDatesSource | null
): InboxLinkOption | null {
  if (link?.task) {
    const file = resolveTaskFile(app, link.task);
    const option = file ? taskOption(app, file, dates) : null;
    if (option) return option;
    const name = file?.basename ?? (link.task.split("/").pop() ?? link.task).replace(/\.md$/i, "");
    return { kind: "task", path: file?.path ?? link.task, name, projects: [], lastActivity: 0, status: "" };
  }
  if (link?.project) return { kind: "project", project: link.project, name: projectDisplayName(link.project) };
  return null;
}

/** Проекты задачи из её frontmatter - как записаны (могут быть с папкой и [[ссылкой]]). */
export function taskProjects(app: App, file: TFile): string[] {
  return taskProjectValues((frontmatterOf(app, file) ?? {}).project);
}

/**
 * Запись привязана к задаче проекта project (имя проекта; во frontmatter задачи проект с папкой и без - один):
 * подпись задачи для записи в заметке проекта - только задача, сам проект там и так ясен. null - запись не задачи
 * этого проекта (или заметки задачи нет: тогда не узнать и её проекта).
 */
export function projectTaskView(app: App, link: InboxLink | null | undefined, project: string): InboxLinkView | null {
  if (!link?.task || !project) return null;
  const file = resolveTaskFile(app, link.task);
  if (!file || !taskProjects(app, file).some((value) => isSameProject(value, project))) return null;
  return bareTaskView(file);
}

/** Проект(ы) для формы новой задачи из привязки записи: проект или проекты привязанной задачи (как во frontmatter). */
export function projectForLink(app: App, link: InboxLink | null | undefined): string {
  if (link?.project) return projectLinkTarget(link.project);
  if (!link?.task) return "";
  const file = resolveTaskFile(app, link.task);
  if (!file) return "";
  return taskProjects(app, file).map(projectLinkTarget).filter(Boolean).join(", ");
}
