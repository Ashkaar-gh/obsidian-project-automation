/**
 * Создание заметок по шаблонам: команды «Создать задачу», «Создать задачу из текущей строки», «Создать проект»,
 * «Открыть или создать ежедневную заметку», «Запись о задаче»; блок opa-daily-nav.
 * Формы - в ui/CreateTaskModals, чистая логика правок ежедневной - в core/DailyNoteEdit,
 * разбор шаблона - в core/TaskTemplateContent.
 */

import {
  Notice,
  TFile,
  parseYaml,
  stringifyYaml,
  MarkdownView,
  type App,
  type Editor,
  type EventRef,
  type MarkdownFileInfo,
} from "obsidian";
import type { ModuleContext, PluginModule } from "./types";
import { Paths } from "../core/Paths";
import {
  DEFAULT_PROJECT,
  DEFAULT_DAILY,
  DEFAULT_TASK,
  DEFAULT_TASK_TEMPLATE_EXAMPLE,
  DEFAULT_TASK_TEMPLATE_EXAMPLE_FILENAME,
} from "../core/DefaultTemplates";
import { updateDataFile } from "../core/GamificationState";
import { formatDateDDMMYYYY, parseDDMMYYYY } from "../core/DateUtils";
import {
  appendHeadingBlockToDaily,
  buildDailyHeadingBlock,
  dailyTaskHeading,
  newDailyNoteCursor,
  replaceLineWithHeadingBlock,
  sectionCursorPosition,
  taskNameFromEditorLine,
} from "../core/DailyNoteEdit";
import { isTaskNote, isTemplateFile } from "../core/TaskNote";
import { openOrRevealFile } from "../core/WorkspaceUtils";
import {
  parseTaskContentTargetFromTemplate,
  removeLinesWithUnfilledPlaceholders,
  replacePlaceholders,
  splitFrontmatterAndBody,
  splitTemplateBodyByTarget,
} from "../core/TaskTemplateContent";
import { buildReminderLine } from "../core/ReminderDataUtils";
import {
  CreateProjectModal,
  CreateTaskModal,
  type CreateTaskFormResult,
  type ExistingTaskMeta,
  type TaskTemplateOption,
} from "../ui/CreateTaskModals";
import { DatePickerModal } from "../ui/DatePickerModal";

export type { CreateTaskFormResult, ExistingTaskMeta, TaskTemplateOption } from "../ui/CreateTaskModals";

/**
 * Строка ежедневной заметки, из которой создаётся задача: после создания она заменяется заголовком
 * `### [[Задача]]` на месте (а не дописывается в конец заметки).
 */
export interface DailySourceLine {
  /** Путь к ежедневной заметке. */
  path: string;
  /** Дата заметки DD-MM-YYYY (из имени файла). */
  date: string;
  /** Индекс строки и её текст на момент открытия формы. */
  line: number;
  lineText: string;
}

function getExistingTaskMeta(app: App): Omit<ExistingTaskMeta, "projects" | "taskTemplates"> {
  const contexts = new Set<string>();
  const environments = new Set<string>();
  const difficulties = new Set<string>();
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) continue;
    if (fm.context != null && String(fm.context).trim()) contexts.add(String(fm.context).trim());
    if (fm.environment != null && String(fm.environment).trim())
      environments.add(String(fm.environment).trim());
    if (fm.difficulty != null && String(fm.difficulty).trim())
      difficulties.add(String(fm.difficulty).trim());
  }
  return {
    contexts: [...contexts].sort(),
    environments: [...environments].sort(),
    difficulties: [...difficulties].sort(),
  };
}

/** Список шаблонов задач: «Обычная» + все .md из templates/task-templates. Frontmatter всегда из файла (без кэша). */
async function getTaskTemplatesList(app: App): Promise<TaskTemplateOption[]> {
  const list: TaskTemplateOption[] = [{ key: "task", label: "Обычная" }];
  const prefix = Paths.TASK_TEMPLATES_FOLDER + "/";
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(prefix) || file.path.slice(prefix.length).includes("/")) continue;
    const key = file.basename;
    let fm: Record<string, unknown> | undefined;
    try {
      const content = await app.vault.read(file);
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        const parsed = parseYaml(fmMatch[1]);
        if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
      }
    } catch {
      fm = undefined;
    }
    const label =
      (typeof fm?.title === "string" && fm.title.trim() ? fm.title.trim() : null) ||
      (typeof fm?.label === "string" && fm.label.trim() ? fm.label.trim() : null) ||
      key;
    const rawProject = fm?.opa_project;
    const defaultProject =
      rawProject != null && String(rawProject).trim()
        ? String(rawProject).trim()
        : undefined;
    const rawGroup = fm?.opa_group;
    const defaultGroup =
      rawGroup != null && String(rawGroup).trim() ? String(rawGroup).trim() : undefined;
    list.push({
      key,
      label,
      ...(defaultProject && { defaultProject }),
      ...(defaultGroup && { defaultGroup }),
    });
  }
  list.sort((a, b) => {
    if (a.key === "task") return -1;
    if (b.key === "task") return 1;
    return a.label.localeCompare(b.label);
  });
  return list;
}

/** Блок frontmatter из объекта: без ключей - пустой блок `---\n---`, а не `{}`. */
function serializeFrontmatter(values: Record<string, unknown>): string {
  const yaml = Object.keys(values).length ? stringifyYaml(values).trimEnd() : "";
  return yaml ? `---\n${yaml}\n---` : "---\n---";
}

/** Удаляет из frontmatter контента поля opa_* (они описывают шаблон, а не задачу). */
function stripOpaFrontmatterFromContent(content: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return content;
  try {
    const fm = parseYaml(fmMatch[1]) as Record<string, unknown> | null;
    if (!fm || typeof fm !== "object") return content;
    const {
      opa_labels: _l,
      opa_prompts: _p,
      opa_project: _proj,
      opa_group: _grp,
      opa_content_target: _contentTarget,
      ...rest
    } = fm;
    // Замена функцией: в значениях YAML могут быть «$&», «$1» и т.п., которые строка-замена интерпретировала бы
    return content.replace(fmMatch[0], () => serializeFrontmatter(rest));
  } catch {
    return content;
  }
}

type PlaceholderValue = string | string[];

/** Подставляет значения через YAML parser/stringifier, не интерпретируя ввод как YAML. */
function replaceFrontmatterPlaceholders(
  frontmatter: string,
  values: Record<string, PlaceholderValue>
): string {
  if (!frontmatter) return "";
  const fmMatch = frontmatter.match(/^---\r?\n([\s\S]*?)\r?\n---$/);
  if (!fmMatch) return frontmatter;

  const parseableYaml = fmMatch[1]
    .replace(/^(\s*[^#\r\n][^:\r\n]*:\s*)%%([^%]+)%%(\s*(?:#.*)?)$/gm, '$1"%%$2%%"$3')
    .replace(/^(\s*-\s*)%%([^%]+)%%(\s*(?:#.*)?)$/gm, '$1"%%$2%%"$3');
  const parsed = parseYaml(parseableYaml);
  if (!parsed || typeof parsed !== "object") return frontmatter;

  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      const exactMatch = value.match(/^%%([^%]+)%%$/);
      if (exactMatch) {
        const key = exactMatch[1].trim();
        if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
      }
      return value.replace(/%%([^%]+)%%/g, (placeholder, rawKey: string) => {
        const key = rawKey.trim();
        if (!Object.prototype.hasOwnProperty.call(values, key)) return placeholder;
        const replacement = values[key];
        return Array.isArray(replacement) ? replacement.join(", ") : replacement;
      });
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolve(item)])
      );
    }
    return value;
  };

  return serializeFrontmatter(resolve(parsed) as Record<string, unknown>);
}

function parseFrontmatterObject(frontmatter: string): Record<string, unknown> {
  const fmMatch = frontmatter.match(/^---\r?\n([\s\S]*?)\r?\n---$/);
  if (!fmMatch) return {};
  const parsedYaml = parseYaml(fmMatch[1]);
  return parsedYaml && typeof parsedYaml === "object" && !Array.isArray(parsedYaml)
    ? { ...(parsedYaml as Record<string, unknown>) }
    : {};
}

/** Записать ключ во frontmatter (создаёт блок, если его нет). */
function setFrontmatterValue(frontmatter: string, key: string, value: unknown): string {
  const parsed = parseFrontmatterObject(frontmatter);
  parsed[key] = value;
  return serializeFrontmatter(parsed);
}

/** Убрать ключ из frontmatter (без блока или без ключа - как было). */
function deleteFrontmatterKey(frontmatter: string, key: string): string {
  if (!frontmatter) return frontmatter;
  const parsed = parseFrontmatterObject(frontmatter);
  if (!(key in parsed)) return frontmatter;
  delete parsed[key];
  return serializeFrontmatter(parsed);
}

/** Удаляет блоки Templater (<%* ... %>, <% ... %> и т.д.), чтобы они не попадали в заметку как текст. */
function stripTemplaterBlocks(content: string): string {
  return content.replace(/<%\*?[\s\S]*?%>/g, "").trim();
}

/** Соседние дни для ежедневной заметки с именем DD-MM-YYYY (null - имя не дата). */
function prevNextDay(basename: string): { prev: string; next: string } | null {
  const date = parseDDMMYYYY(basename);
  if (!date) return null;
  const prev = new Date(date);
  prev.setDate(prev.getDate() - 1);
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return { prev: formatDateDDMMYYYY(prev), next: formatDateDDMMYYYY(next) };
}

/** Строка навигации для ежедневной заметки: ← [[prev]] | [[next]] → */
function buildDailyNavLine(dateStr: string): string {
  const info = prevNextDay(dateStr);
  if (!info) return "";
  const folder = Paths.DAILY_FOLDER.replace(/\/?$/, "");
  const prevLink = `${folder}/${info.prev}.md`;
  const nextLink = `${folder}/${info.next}.md`;
  return `← [[${prevLink}|${info.prev}]]  |  [[${nextLink}|${info.next}]] →`;
}

const DAILY_FILENAME_REGEX = /^\d{2}-\d{2}-\d{4}\.md$/;

export class NoteTemplatesModule implements PluginModule {
  private ctx: ModuleContext;
  private onDailyCreated: ((file: TFile) => void) | null = null;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  load(): void {
    this.onDailyCreated = (file: TFile) => {
      if (!(file instanceof TFile)) return;
      const folder = Paths.DAILY_FOLDER.replace(/\/?$/, "");
      if (!file.path.startsWith(folder + "/") || !DAILY_FILENAME_REGEX.test(file.name)) return;
      const dateStr = file.basename;
      window.setTimeout(async () => {
        try {
          let needsContent = false;
          await this.ctx.app.vault.process(file, (content) => {
            if (content.includes("%%daily_nav%%")) {
              return content.replace(/%%daily_nav%%/g, buildDailyNavLine(dateStr));
            }
            needsContent = content.trim() === "";
            return content;
          });
          if (needsContent) {
            const newContent = await this.getDailyNoteContentForDate(dateStr);
            await this.ctx.app.vault.process(file, (content) =>
              content.trim() === "" ? newContent : content
            );
          }
        } catch (e) {
          console.error("[OPA] daily create handler:", e);
        }
      }, 0);
    };
    this.ctx.app.workspace.onLayoutReady(() => {
      if (!this.onDailyCreated) return;
      const vault = this.ctx.app.vault as unknown as {
        on(e: "create", cb: (f: TFile) => void): EventRef;
      };
      this.ctx.plugin.registerEvent(vault.on("create", this.onDailyCreated));
    });

    this.ctx.plugin.addCommand({
      id: "create-task",
      name: "Создать задачу",
      callback: () => this.openCreateTask(),
    });
    this.ctx.plugin.addCommand({
      id: "create-task-from-line",
      name: "Создать задачу из текущей строки",
      editorCallback: (editor, view) => void this.openCreateTaskFromEditor(editor, view),
    });
    this.ctx.plugin.addCommand({
      // id прежний (команда называлась «Запись о задаче за сегодня»): по нему Obsidian хранит назначенный хоткей
      id: "task-daily-entry-today",
      name: "Запись о задаче",
      checkCallback: (checking) => this.runEntryForActiveTask(checking),
    });
    this.ctx.plugin.addCommand({
      id: "create-project",
      name: "Создать проект",
      callback: () => this.openCreateProject(),
    });
    this.ctx.plugin.addCommand({
      id: "create-daily-note",
      name: "Открыть или создать ежедневную заметку",
      callback: () => this.createDailyNote(),
    });
    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-daily-nav", (_source, el) => {
      this.renderDailyNav(el);
    });
  }

  unload(): void {
    // Событие create зарегистрировано через registerEvent - снимается автоматически.
    this.onDailyCreated = null;
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      if (!part) continue;
      current += (current ? "/" : "") + part;
      if (!this.ctx.app.vault.getAbstractFileByPath(current)) {
        await this.ctx.app.vault.createFolder(current);
      }
    }
  }

  /** Создаёт папку templates/task-templates и файл-пример task-example.md, если его ещё нет. Вызывается из настроек. */
  async createExampleTaskTemplate(): Promise<void> {
    const folder = Paths.TASK_TEMPLATES_FOLDER;
    const path = `${folder}/${DEFAULT_TASK_TEMPLATE_EXAMPLE_FILENAME}`;
    const existing = this.ctx.app.vault.getAbstractFileByPath(path);
    if (existing) {
      new Notice("Пример шаблона уже есть: " + path);
      return;
    }
    await this.ensureFolderExists(folder);
    await this.ctx.app.vault.create(path, DEFAULT_TASK_TEMPLATE_EXAMPLE);
    new Notice("Создан пример шаблона задачи: " + path);
  }

  /**
   * Открыть модалку создания задачи. options.defaultName - предзаполнить название; options.defaultProject - проект
   * (из привязки записи блокнота); options.onSuccess - вызвать после успешного создания (с файлом задачи; если
   * задача не создана, например нет шаблона, - не вызывается); options.dailySource - строка ежедневной заметки,
   * которую заменить заголовком задачи.
   */
  async openCreateTask(options?: {
    defaultName?: string;
    defaultProject?: string;
    onSuccess?: (file: TFile) => void | Promise<void>;
    dailySource?: DailySourceLine;
  }): Promise<void> {
    const [projects, taskTemplates] = await Promise.all([
      this.ctx.plugin.getProjectsSortedByTaskCount(),
      getTaskTemplatesList(this.ctx.app),
    ]);
    const meta: ExistingTaskMeta = {
      ...getExistingTaskMeta(this.ctx.app),
      projects,
      taskTemplates,
      initialName: options?.defaultName,
      initialDate: options?.dailySource?.date,
      initialProject: options?.defaultProject,
    };
    const onDone = (p: CreateTaskFormResult) => {
      return this.createTask(p, options?.dailySource).then(async (file) => {
        if (file) await options?.onSuccess?.(file);
      });
    };
    const modal = new CreateTaskModal(this.ctx, onDone, meta);
    modal.open();
  }

  /**
   * Команда «Создать задачу из текущей строки»: название - выделение или строка под курсором
   * (без маркеров списка и ссылок), а если заметка ежедневная - после создания эта строка станет заголовком задачи.
   */
  private async openCreateTaskFromEditor(editor: Editor, view: MarkdownView | MarkdownFileInfo): Promise<void> {
    const cursorLine = editor.getCursor("from").line;
    const lineText = editor.getLine(cursorLine);
    const selection = editor.getSelection();
    const defaultName = taskNameFromEditorLine(selection.trim() ? selection : lineText);
    const file = view.file;
    let dailySource: DailySourceLine | undefined;
    if (file && this.isDailyNoteFile(file) && lineText.trim()) {
      dailySource = { path: file.path, date: file.basename, line: cursorLine, lineText };
    }
    await this.openCreateTask({ defaultName, dailySource });
  }

  private isDailyNoteFile(file: TFile): boolean {
    const folder = Paths.DAILY_FOLDER.replace(/\/?$/, "");
    return file.path.startsWith(folder + "/") && DAILY_FILENAME_REGEX.test(file.name);
  }

  /** Активная заметка, если это задача (по frontmatter, как на доске; шаблоны и страницы проектов не считаются). */
  private activeTaskFile(): TFile | null {
    const file = this.ctx.app.workspace.getActiveFile();
    if (!file || isTemplateFile(file)) return null;
    return isTaskNote(file, this.ctx.app.metadataCache.getFileCache(file)) ? file : null;
  }

  /** Команда «Запись о задаче»: доступна только в открытой заметке-задаче. */
  private runEntryForActiveTask(checking: boolean): boolean {
    const file = this.activeTaskFile();
    if (!file) return false;
    if (!checking) void this.chooseDateAndOpenEntry(file);
    return true;
  }

  /**
   * Команда «Запись о задаче»: окно даты открывается на сегодняшнем дне (Enter - запись за сегодня,
   * ← и Enter - за вчера), запись идёт в ежедневную на выбранный день. Отмена (Esc, клик вне окна) ничего не меняет.
   */
  private async chooseDateAndOpenEntry(taskFile: TFile): Promise<void> {
    const date = await this.pickEntryDate();
    if (!date) return;
    await this.openEntryForTask(taskFile, formatDateDDMMYYYY(date));
  }

  /** Окно выбора дня записи, по умолчанию сегодня; null - отмена. */
  private pickEntryDate(): Promise<Date | null> {
    return new Promise((resolve) => {
      new DatePickerModal(this.ctx.app, { title: "Дата записи", initial: new Date(), onDone: resolve }).open();
    });
  }

  /**
   * Заголовок задачи в ежедневной заметке на день dateStr (DD-MM-YYYY; заметка и заголовок создаются
   * при необходимости), затем ежедневная открывается с курсором в конце секции задачи -
   * работа идёт в ежедневной, задача остаётся для чтения.
   */
  private async openEntryForTask(taskFile: TFile, dateStr: string): Promise<void> {
    const taskName = taskFile.basename;
    const dailyFile = await this.resolveDailyFile(dateStr);
    const heading = dailyTaskHeading(taskName);
    await this.ctx.app.vault.process(dailyFile, (content) =>
      content.includes(heading) ? content : appendHeadingBlockToDaily(content, buildDailyHeadingBlock(taskName))
    );
    await this.openDailyAtHeading(dailyFile, heading);
  }

  /**
   * Открыть ежедневную заметку в режиме редактирования и поставить курсор в секцию задачи: в конец последней
   * строки записи, а в пустой секции - под заголовок. Открытый редактор подхватывает только что записанный
   * заголовок с небольшой задержкой, поэтому строка ищется с повторами.
   */
  private async openDailyAtHeading(dailyFile: TFile, heading: string): Promise<void> {
    await openOrRevealFile(this.ctx.app, dailyFile);
    const view = this.ctx.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== dailyFile.path) return;
    if (view.getMode() === "preview") {
      await view.setState({ ...view.getState(), mode: "source" }, { history: false });
    }
    const editor = view.editor;
    let lines: string[] = [];
    let headingLine = -1;
    for (let attempt = 0; attempt < 10 && headingLine === -1; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100));
      lines = editor.getValue().split("\n");
      headingLine = lines.findIndex((line) => line.trim() === heading);
    }
    if (headingLine === -1) return;
    const target = sectionCursorPosition(lines, headingLine);
    if (target.insertNewline) editor.replaceRange("\n", { line: headingLine, ch: lines[headingLine].length });
    editor.setCursor({ line: target.line, ch: target.ch });
    editor.scrollIntoView({ from: { line: headingLine, ch: 0 }, to: { line: target.line, ch: 0 } }, true);
    editor.focus();
  }

  private openCreateProject(): void {
    const modal = new CreateProjectModal(this.ctx.app, (p) => this.createProject(p));
    modal.open();
  }

  private async getTaskTemplateContent(key: string): Promise<string> {
    if (key === "task") {
      const file = this.ctx.app.vault.getAbstractFileByPath(Paths.TASK_TEMPLATE_PATH);
      if (file instanceof TFile) return await this.ctx.app.vault.cachedRead(file);
      return DEFAULT_TASK;
    }
    const path = `${Paths.TASK_TEMPLATES_FOLDER}/${key}.md`;
    const file = this.ctx.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return "";
    return await this.ctx.app.vault.cachedRead(file);
  }

  /** Одно значение остаётся scalar, несколько значений становятся YAML sequence. */
  private formatYamlList(valueStr: string): PlaceholderValue {
    const parts = (valueStr ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return parts;
  }

  private async getProjectTemplateContent(): Promise<string> {
    const file = this.ctx.app.vault.getAbstractFileByPath(Paths.PROJECT_TEMPLATE_PATH);
    if (file instanceof TFile) return await this.ctx.app.vault.cachedRead(file);
    return DEFAULT_PROJECT;
  }

  private async getDailyTemplateContent(): Promise<string> {
    const file = this.ctx.app.vault.getAbstractFileByPath(Paths.DAILY_TEMPLATE_PATH);
    if (file instanceof TFile) return await this.ctx.app.vault.cachedRead(file);
    return DEFAULT_DAILY;
  }

  /**
   * Создать заметку задачи по форме. dailySource - строка ежедневной заметки, из которой вызвана команда:
   * если дата ежедневной в форме совпадает с датой этой заметки, строка заменяется заголовком задачи на месте.
   */
  /** Создать задачу по данным формы; null - задача не создана (например, нет шаблона). */
  private async createTask(p: CreateTaskFormResult, dailySource?: DailySourceLine): Promise<TFile | null> {
    const resolvedDate = p.date.trim() || formatDateDDMMYYYY(new Date());
    let content = await this.getTaskTemplateContent(p.templateKey);
    if (!content && p.templateKey !== "task") {
      new Notice(`Шаблон не найден: ${Paths.TASK_TEMPLATES_FOLDER}/${p.templateKey}.md`);
      return null;
    }
    if (!content) content = DEFAULT_TASK;
    const contentTarget = parseTaskContentTargetFromTemplate(content);
    content = content.replace(/```dataviewjs[\s\S]*?```/g, "```opa-task-view\n```");
    let { frontmatter, body } = splitFrontmatterAndBody(content);
    const yamlValues: Record<string, PlaceholderValue> = {
      project: this.formatYamlList(p.project),
      context: this.formatYamlList(p.context),
      environment: this.formatYamlList(p.environment),
      date: resolvedDate,
      difficulty: p.difficulty,
      group: p.group,
    };
    frontmatter = replaceFrontmatterPlaceholders(frontmatter, yamlValues);
    body = replacePlaceholders(body, {
      project: p.project,
      context: p.context,
      environment: p.environment,
      date: resolvedDate,
      difficulty: p.difficulty,
      group: p.group,
    });
    // Статус из формы записывается всегда - и когда в шаблоне нет ключа status (раньше он тогда терялся);
    // пустой статус убирает ключ.
    const status = p.status.trim();
    frontmatter = status
      ? setFrontmatterValue(frontmatter, "status", status)
      : deleteFrontmatterKey(frontmatter, "status");
    const enableDeadline = this.ctx.plugin.settings.enableDeadline;
    if (enableDeadline) {
      const deadlineVal = p.deadline ?? "";
      frontmatter = replaceFrontmatterPlaceholders(frontmatter, { deadline: deadlineVal });
      frontmatter = setFrontmatterValue(frontmatter, "deadline", deadlineVal);
      body = replacePlaceholders(body, { deadline: deadlineVal });
    } else {
      frontmatter = frontmatter.replace(/\n?\s*deadline:\s*["']?%%deadline%%["']?\s*\r?\n?/g, "\n");
    }
    // В заметку задачи идёт только часть шаблона для задачи; часть для ежедневной (<!-- opa:daily -->) не используется:
    // шаблон нужен ради проекта, группы и скелета заметки, текст в ежедневную пишется руками.
    const taskBodyContent = removeLinesWithUnfilledPlaceholders(
      splitTemplateBodyByTarget(body, contentTarget).taskBody
    ).trim();

    const safeName = p.name.replace(/[/\\]/g, "-") + ".md";
    const path = safeName;
    if (this.ctx.app.vault.getAbstractFileByPath(path)) {
      throw new Error(`Задача «${p.name}» уже существует.`);
    }
    const taskFileRawContent = taskBodyContent ? `${frontmatter}\n${taskBodyContent}\n` : `${frontmatter}\n`;
    const taskFileContent = stripOpaFrontmatterFromContent(taskFileRawContent);
    const file = await this.ctx.app.vault.create(path, taskFileContent);
    new Notice(`Создана задача: ${p.name}`);
    await this.ctx.app.workspace.getLeaf(true).openFile(file);
    if (status.toLowerCase() === "готово") {
      await this.ctx.eventBus.emit("task:completed", {
        path: file.path,
        difficulty: p.difficulty?.trim() ? p.difficulty : null,
      });
    }
    this.ctx.plugin.tasksDashboard?.scheduleRefresh();
    const replaced = dailySource ? await this.replaceDailySourceLine(dailySource, p) : false;
    if (!replaced) await this.ensureDailyHeading(p.name, p.dailyHeadingMode, p.dailyHeadingDate);
    if (
      enableDeadline &&
      p.deadline?.trim() &&
      this.ctx.plugin.settings.enableReminders &&
      this.ctx.plugin.settings.enableDeadlineReminders
    ) {
      const deadlineDate = parseDDMMYYYY(p.deadline);
      if (deadlineDate) {
        deadlineDate.setHours(10, 0, 0, 0);
        const leadDays = Math.max(0, this.ctx.plugin.settings.deadlineReminderLeadDays);
        const reminderDate = new Date(deadlineDate);
        reminderDate.setDate(reminderDate.getDate() - leadDays);
        const reminderLine = buildReminderLine(`Дедлайн по задаче: ${p.name}`, reminderDate);
        const reminders = this.ctx.plugin.reminders;
        if (reminders) {
          await reminders.addReminderToData(reminderLine);
        } else {
          await updateDataFile(this.ctx.plugin, (data) => ({ reminders: [...(data.reminders ?? []), reminderLine] }));
          await this.ctx.plugin.remindersIndex.refreshDataJson();
        }
      }
    }
    return file;
  }

  private async createProject(p: { name: string }): Promise<void> {
    const templateContent = await this.getProjectTemplateContent();
    let { frontmatter, body } = splitFrontmatterAndBody(templateContent);
    frontmatter = replaceFrontmatterPlaceholders(frontmatter, { projectName: p.name });
    body = replacePlaceholders(body, { projectName: p.name });
    let content = frontmatter ? `${frontmatter}\n${body}` : body;
    content = content.replace(/```dataviewjs[\s\S]*?```/g, "```opa-project-view\n```");

    const path = p.name.endsWith(".md") ? p.name : p.name + ".md";
    const parts = path.split("/");
    if (parts.length > 1) {
      const folderPath = parts.slice(0, -1).join("/");
      await this.ensureFolderExists(folderPath);
    }

    const file = await this.ctx.app.vault.create(path, content);
    await this.ctx.plugin.addProject(p.name);
    new Notice(`Создан проект: ${p.name}`);
    await this.ctx.plugin.tasksDashboard?.forceRefresh();
    await this.ctx.app.workspace.getLeaf(true).openFile(file);
  }

  private async getDailyNoteContentForDate(dateStr: string): Promise<string> {
    let content = await this.getDailyTemplateContent();
    content = stripTemplaterBlocks(content);
    if (!content.trim()) content = DEFAULT_DAILY;
    return content.replace(/%%daily_nav%%/g, buildDailyNavLine(dateStr));
  }

  /** Дата ежедневной заметки по режиму формы; null - не писать («-» или некорректная дата). */
  private resolveDailyTargetDate(mode: "today" | "choose" | "none", dateStr: string): string | null {
    if (mode === "none") return null;
    if (mode === "today") return formatDateDDMMYYYY(new Date());
    const targetDate = dateStr.trim();
    return parseDDMMYYYY(targetDate) ? targetDate : null;
  }

  /** Файл ежедневной заметки на дату; создаётся по шаблону, если его ещё нет. */
  private async resolveDailyFile(targetDate: string): Promise<TFile> {
    const dailyFolder = Paths.DAILY_FOLDER.replace(/\/?$/, "");
    const path = `${dailyFolder}/${targetDate}.md`;
    const existing = this.ctx.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    await this.ensureFolderExists(dailyFolder);
    const content = await this.getDailyNoteContentForDate(targetDate);
    const file = await this.ctx.app.vault.create(path, content);
    new Notice(`Создана ежедневная заметка: ${targetDate}`);
    return file;
  }

  /**
   * Задача создана из строки ежедневной заметки: заменить эту строку заголовком задачи на месте.
   * Только если дата ежедневной в форме - та же заметка (иначе, как и при «-», строка остаётся, а заголовок
   * идёт по обычному правилу). false - заменить не удалось (строка уже изменена или файл пропал): вызывающий код
   * дописывает заголовок как обычно.
   */
  private async replaceDailySourceLine(source: DailySourceLine, p: CreateTaskFormResult): Promise<boolean> {
    const targetDate = this.resolveDailyTargetDate(p.dailyHeadingMode, p.dailyHeadingDate);
    if (!targetDate || targetDate !== source.date) return false;
    const file = this.ctx.app.vault.getAbstractFileByPath(source.path);
    if (!(file instanceof TFile)) return false;
    const headingBlock = buildDailyHeadingBlock(p.name);
    let replaced = false;
    await this.ctx.app.vault.process(file, (content) => {
      if (content.includes(dailyTaskHeading(p.name))) return content;
      const next = replaceLineWithHeadingBlock(content, source.line, source.lineText, headingBlock);
      if (next == null) return content;
      replaced = true;
      return next;
    });
    return replaced;
  }

  /** Заголовок задачи в ежедневной заметке на выбранную дату (если его там ещё нет). */
  private async ensureDailyHeading(taskName: string, mode: "today" | "choose" | "none", dateStr: string): Promise<void> {
    const targetDate = this.resolveDailyTargetDate(mode, dateStr);
    if (!targetDate) return;
    const file = await this.resolveDailyFile(targetDate);
    const headingToAdd = dailyTaskHeading(taskName);
    await this.ctx.app.vault.process(file, (dailyNoteContent) =>
      dailyNoteContent.includes(headingToAdd)
        ? dailyNoteContent
        : appendHeadingBlockToDaily(dailyNoteContent, buildDailyHeadingBlock(taskName))
    );
  }

  private async createDailyNote(): Promise<void> {
    const dateStr = formatDateDDMMYYYY(new Date());
    const folder = Paths.DAILY_FOLDER.replace(/\/?$/, "");
    const path = `${folder}/${dateStr}.md`;
    const existing = this.ctx.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      // Заметка уже есть: перейти к ней (в открытую вкладку, если она есть), без уведомления
      await openOrRevealFile(this.ctx.app, existing);
      return;
    }
    await this.ensureFolderExists(folder);
    const content = await this.getDailyNoteContentForDate(dateStr);
    const file = await this.ctx.app.vault.create(path, content);
    new Notice(`Создана ежедневная заметка: ${dateStr}`);
    const leaf = this.ctx.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    await this.placeCursorBelowDailyNav(leaf.view, file);
  }

  /**
   * Новая ежедневная заметка открывается в режиме редактирования с курсором под строкой навигации
   * «← … | … →», чтобы сразу писать. Только что открытый редактор получает содержимое с небольшой задержкой,
   * поэтому текст читается с повторами (как в openDailyAtHeading).
   */
  private async placeCursorBelowDailyNav(view: unknown, dailyFile: TFile): Promise<void> {
    if (!(view instanceof MarkdownView) || view.file?.path !== dailyFile.path) return;
    if (view.getMode() === "preview") {
      await view.setState({ ...view.getState(), mode: "source" }, { history: false });
    }
    const editor = view.editor;
    let lines: string[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100));
      lines = editor.getValue().split("\n");
      if (lines.some((line) => line.trim() !== "")) break;
    }
    const target = newDailyNoteCursor(lines);
    if (target.insertNewline) {
      const last = target.line - 1;
      editor.replaceRange("\n", { line: last, ch: lines[last].length });
    }
    editor.setCursor({ line: target.line, ch: target.ch });
    editor.focus();
  }

  private renderDailyNav(el: HTMLElement): void {
    const file = this.ctx.app.workspace.getActiveFile();
    if (!file) {
      el.createSpan({ text: "Откройте ежедневную заметку (имя DD-MM-YYYY)." });
      return;
    }
    const basename = file.basename;
    const info = prevNextDay(basename);
    if (!info) {
      el.createSpan({ text: "Имя файла должно быть в формате DD-MM-YYYY." });
      return;
    }
    const folder = file.parent?.path ? file.parent.path + "/" : "";
    const prevPath = folder + info.prev + ".md";
    const nextPath = folder + info.next + ".md";
    const wrap = el.createDiv();
    wrap.addClass("opa-daily-nav");
    const prevLink = wrap.createEl("a", { href: prevPath, cls: "internal-link" });
    prevLink.setAttribute("data-href", prevPath);
    prevLink.setText("← " + info.prev);
    wrap.createSpan({ text: "  |  " });
    const nextLink = wrap.createEl("a", { href: nextPath, cls: "internal-link" });
    nextLink.setAttribute("data-href", nextPath);
    nextLink.setText(info.next + " →");
  }
}
