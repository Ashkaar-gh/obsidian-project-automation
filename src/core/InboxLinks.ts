/**
 * К чему относится запись блокнота (поле «Относится к»): варианты для выбора (проекты и задачи со статусами),
 * поиск по ним, подписи, контекст по заголовкам заметки. Чистые функции без Obsidian API (покрыты тестами);
 * данные о задачах собирает InboxLinkSources.
 */

import { markdownHeadings, wikiLinkTargets } from "./DailyNoteEdit";
import { getConfig, getWeight, isEmptyStatus } from "./StatusConfig";
import type { InboxLink } from "./InboxEntries";

/** Задача как вариант выбора. */
export interface InboxTaskOption {
  kind: "task";
  /** Путь заметки-задачи. */
  path: string;
  /** Имя заметки (без папки и .md). */
  name: string;
  /** Проекты из frontmatter задачи - как записаны (могут быть с папкой). */
  projects: string[];
  /** Когда над задачей работали последний раз (мс): правка заметки или запись в ежедневной. */
  lastActivity: number;
  /** Статус из frontmatter, как записан («В работе»); пусто - без статуса. */
  status: string;
}

/** Проект как вариант выбора. */
export interface InboxProjectOption {
  kind: "project";
  /** Значение из списка проектов (как во frontmatter задач). */
  project: string;
  /** Имя для показа (без папки). */
  name: string;
}

export type InboxLinkOption = InboxTaskOption | InboxProjectOption;

/** Сколько вариантов показывать в списке выбора. */
export const LINK_OPTIONS_LIMIT = 50;

/** Имя проекта для показа: без [[скобок]], алиаса-пути, папки и .md («[[Проекты/Тест]]» → «Тест»). */
export function projectDisplayName(raw: string): string {
  let value = String(raw ?? "").trim();
  const link = value.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
  if (link) value = link[2]?.trim() || link[1];
  value = value.replace(/\.md$/i, "");
  return (value.split("/").pop() ?? value).trim();
}

/** Проект как цель ссылки: «[[Проекты/Тест|Тест]]» → «Проекты/Тест», без скобок и .md; обычное значение - как есть. */
export function projectLinkTarget(raw: string): string {
  const value = String(raw ?? "").trim();
  const link = value.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/);
  return (link ? link[1] : value).replace(/\.md$/i, "").trim();
}

/**
 * Один ли это проект: значение проекта (с папкой, [[ссылкой]] или без) и имя проекта, без учёта регистра
 * («Проекты/Trino» и «trino» - один проект).
 */
export function isSameProject(value: string, projectName: string): boolean {
  const name = projectDisplayName(value).toLowerCase();
  return name !== "" && name === projectDisplayName(projectName).toLowerCase();
}

/** Проекты задачи из frontmatter: строка через запятую, список, [[ссылка]] - плоский список непустых строк. */
export function taskProjectValues(project: unknown): string[] {
  if (project == null) return [];
  if (Array.isArray(project)) return project.flatMap((p) => taskProjectValues(p));
  return String(project)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Проекты варианта одной строкой для показа: «Trino», «Trino, Spark»; у проекта - пусто. */
export function linkOptionProjects(option: InboxLinkOption): string {
  if (option.kind !== "task") return "";
  const names: string[] = [];
  for (const project of option.projects) {
    const name = projectDisplayName(project);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(", ");
}

/** Подпись варианта в поле «Относится к»: «Trino ACL · Trino», у проекта - его имя. */
export function linkOptionLabel(option: InboxLinkOption): string {
  const projects = linkOptionProjects(option);
  return projects ? `${option.name} · ${projects}` : option.name;
}

/** Что записать в data.json для выбранного варианта. */
export function optionToLink(option: InboxLinkOption): InboxLink {
  return option.kind === "task" ? { task: option.path } : { project: option.project };
}

/** Задача не закрыта: не «Готово» и не «Отменено». */
export function isOpenTaskStatus(status: string): boolean {
  const key = getConfig(status)?.key;
  return key !== "готово" && key !== "отменено";
}

/** Подпись статуса, как на доске: «⚙️ В работе»; незнакомый статус - как записан; без статуса - пусто. */
export function taskStatusLabel(status: string): string {
  if (isEmptyStatus(status)) return "";
  const config = getConfig(status);
  return config ? `${config.icon} ${config.label}` : String(status).trim();
}

/** Задачи по статусу, как на доске: «В работе» первыми, «Готово» и «Отменено» в конце; внутри - недавние сверху. */
export function sortTasksByStatus(tasks: readonly InboxTaskOption[]): InboxTaskOption[] {
  return [...tasks].sort(
    (a, b) =>
      getWeight(a.status) - getWeight(b.status) || b.lastActivity - a.lastActivity || a.name.localeCompare(b.name)
  );
}

/**
 * Варианты выбора. Сверху все проекты - из списка проектов и из задач, без повторов (с папкой и без - один проект):
 * сначала проекты с задачами «В работе», потом - с незакрытыми задачами, дальше как в списке. Ниже все задачи
 * по статусу (см. sortTasksByStatus).
 */
export function buildLinkOptions(tasks: readonly InboxTaskOption[], projects: readonly string[]): InboxLinkOption[] {
  const projectKey = (value: string): string => projectDisplayName(value).toLowerCase();
  const seen = new Set<string>();
  const projectOptions: InboxProjectOption[] = [];
  const addProject = (raw: string): void => {
    const project = String(raw ?? "").trim();
    const name = projectDisplayName(project);
    const key = name.toLowerCase();
    if (!project || !name || seen.has(key)) return;
    seen.add(key);
    projectOptions.push({ kind: "project", project, name });
  };
  for (const project of projects) addProject(project);
  for (const task of tasks) for (const project of task.projects) addProject(project);

  const counts = new Map<string, { inWork: number; open: number }>();
  for (const task of tasks) {
    const inWork = getConfig(task.status)?.key === "в работе";
    const open = isOpenTaskStatus(task.status);
    for (const key of new Set(task.projects.map(projectKey).filter(Boolean))) {
      const count = counts.get(key) ?? { inWork: 0, open: 0 };
      if (inWork) count.inWork++;
      if (open) count.open++;
      counts.set(key, count);
    }
  }
  const rank = (option: InboxProjectOption) => counts.get(projectKey(option.project)) ?? { inWork: 0, open: 0 };
  const sortedProjects = projectOptions
    .map((option, index) => ({ option, index, count: rank(option) }))
    .sort((a, b) => b.count.inWork - a.count.inWork || b.count.open - a.count.open || a.index - b.index)
    .map((item) => item.option);
  return [...sortedProjects, ...sortTasksByStatus(tasks)];
}

/** Место варианта в выдаче поиска: проекты сверху, задачи - по статусу, как на доске. */
function optionRank(option: InboxLinkOption): number {
  return option.kind === "project" ? 0 : getWeight(option.status);
}

/** Текст для поиска: регистр и «ё» не мешают. */
function searchText(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/**
 * Поиск по вариантам: каждое слово запроса должно встретиться в имени задачи или её проекта. Порядок: проекты,
 * затем задачи по статусу («В работе» первыми); при равном статусе сначала совпавшие по имени, потом - только
 * по проекту; дальше - исходный порядок. Без запроса - исходный порядок как есть.
 */
export function filterLinkOptions<T extends InboxLinkOption>(
  options: readonly T[],
  query: string,
  limit = LINK_OPTIONS_LIMIT
): T[] {
  const words = searchText(query ?? "").split(" ").filter(Boolean);
  if (words.length === 0) return options.slice(0, limit);
  const found: Array<{ option: T; tier: number; index: number }> = [];
  options.forEach((option, index) => {
    const name = searchText(option.name);
    if (words.every((word) => name.includes(word))) {
      found.push({ option, tier: 0, index });
      return;
    }
    const full = searchText(`${option.name} ${option.kind === "task" ? option.projects.join(" ") : option.project}`);
    if (words.every((word) => full.includes(word))) found.push({ option, tier: 1, index });
  });
  found.sort((a, b) => optionRank(a.option) - optionRank(b.option) || a.tier - b.tier || a.index - b.index);
  return found.slice(0, limit).map((item) => item.option);
}

/**
 * Цели [[ссылок]] из заголовков, под которыми стоит строка line: от ближайшего заголовка к внешним
 * («#### Образ» внутри «### [[Задача]]» - сначала подзаголовок, потом задача). Строка самого заголовка тоже в нём.
 */
export function headingLinkTargetsAtLine(lines: readonly string[], line: number): string[] {
  const headings = markdownHeadings(lines).filter((h) => h.line <= line);
  const targets: string[] = [];
  let level = Infinity;
  for (let i = headings.length - 1; i >= 0 && level > 1; i--) {
    const heading = headings[i];
    if (heading.level >= level) continue;
    level = heading.level;
    for (const target of wikiLinkTargets(heading.text)) {
      if (!targets.includes(target)) targets.push(target);
    }
  }
  return targets;
}

/**
 * Проект(ы) для формы задачи - как в её списке проектов: «trino» → «Trino», «Тест» → «Проекты/Тест».
 * Нет в списке - как есть. Несколько - через запятую, как в форме.
 */
export function matchProjectsInList(value: string, list: readonly string[]): string {
  const out: string[] = [];
  for (const part of String(value ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const exact = list.find((p) => p.toLowerCase() === part.toLowerCase());
    const byName = exact ?? list.find((p) => projectDisplayName(p).toLowerCase() === projectDisplayName(part).toLowerCase());
    const project = byName ?? part;
    if (!out.includes(project)) out.push(project);
  }
  return out.join(", ");
}

/**
 * Ключ привязки для группировки записей: одна задача - по пути, один проект - по имени (с папкой и без - один).
 * null - привязки нет.
 */
export function inboxLinkKey(link: InboxLink | null | undefined): string | null {
  if (link?.task) return `task:${link.task}`;
  if (link?.project) {
    const name = projectDisplayName(link.project).toLowerCase();
    return name ? `project:${name}` : null;
  }
  return null;
}

/** Строка списка блокнота: отдельная запись или группа записей с одной привязкой. */
export type InboxListItem = { kind: "entry"; line: string } | { kind: "group"; key: string; lines: string[] };

/**
 * Записи с одной привязкой (от двух) - в группу. Группа стоит на месте самой ранней своей записи, внутри - записи
 * в прежнем порядке. Записи без привязки и одиночные остаются на своих местах.
 */
export function groupInboxEntries(
  lines: readonly string[],
  linkOf: (line: string) => InboxLink | null | undefined
): InboxListItem[] {
  const keys = lines.map((line) => inboxLinkKey(linkOf(line)));
  const counts = new Map<string, number>();
  for (const key of keys) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  const items: InboxListItem[] = [];
  const groups = new Map<string, { kind: "group"; key: string; lines: string[] }>();
  lines.forEach((line, index) => {
    const key = keys[index];
    if (!key || (counts.get(key) ?? 0) < 2) {
      items.push({ kind: "entry", line });
      return;
    }
    let group = groups.get(key);
    if (!group) {
      group = { kind: "group", key, lines: [] };
      groups.set(key, group);
      items.push(group);
    }
    group.lines.push(line);
  });
  return items;
}
