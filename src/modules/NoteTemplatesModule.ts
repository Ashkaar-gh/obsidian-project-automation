import type { App } from "obsidian";
import { Modal, Setting, Notice, TFile, parseYaml, stringifyYaml } from "obsidian";
import type { ModuleContext } from "./types";
import { Paths } from "../core/Paths";
import {
  DEFAULT_PROJECT,
  DEFAULT_DAILY,
  DEFAULT_TASK,
  DEFAULT_TASK_TEMPLATE_EXAMPLE,
  DEFAULT_TASK_TEMPLATE_EXAMPLE_FILENAME,
} from "../core/DefaultTemplates";
import { readDataFile, writeDataFile } from "../core/GamificationState";
import { formatReminderDateTag } from "../core/ReminderDataUtils";

/**
 * Создание заметок по шаблонам: команды «Создать заметку», «Создать задачу», «Создать проект»,
 * ежедневная заметка, заметка из файла в templates/; блок opa-daily-nav.
 */

type NoteType = "task" | "project" | "daily" | "from-template";

export interface TaskTemplateOption {
  key: string;
  label: string;
  /** Проект по умолчанию для этого шаблона (из opa_project во frontmatter). */
  defaultProject?: string;
  /** Группа по умолчанию для этого шаблона (из opa_group во frontmatter). */
  defaultGroup?: string;
}

/** Описание поля в модалке «Создать задачу» из frontmatter шаблона (opa_prompts). */
export interface OpaPrompt {
  key: string;
  label: string;
  optional?: boolean;
  type?: "text" | "suggester";
  options?: Array<{ id: string; label?: string; values: Record<string, string> }>;
}

export interface ExistingTaskMeta {
  projects: string[];
  contexts: string[];
  environments: string[];
  difficulties: string[];
  taskTemplates: TaskTemplateOption[];
  /** Динамические поля по шаблону: templateKey -> opa_prompts из frontmatter. */
  templatePrompts?: Map<string, OpaPrompt[]>;
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
    contexts: [...contexts].sort().filter((c) => c.toLowerCase() !== "росбанк"),
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

function parseOpaPrompt(raw: unknown): OpaPrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const key = typeof o.key === "string" ? o.key.trim() : "";
  const label = typeof o.label === "string" ? o.label.trim() : key;
  if (!key) return null;
  const prompt: OpaPrompt = { key, label };
  if (o.optional === true) prompt.optional = true;
  const type = o.type;
  if (type === "suggester" || type === "text") prompt.type = type;
  else prompt.type = "text";
  if (prompt.type === "suggester" && Array.isArray(o.options)) {
    prompt.options = [];
    for (const opt of o.options) {
      if (!opt || typeof opt !== "object") continue;
      const optObj = opt as Record<string, unknown>;
      const id = String(optObj.id ?? "");
      let values = optObj.values;
      if (typeof values === "string") {
        try {
          values = JSON.parse(values) as Record<string, unknown>;
        } catch {
          values = null;
        }
      }
      if (!id) continue;
      const valuesRecord: Record<string, string> = {};
      if (values && typeof values === "object" && !Array.isArray(values)) {
        for (const [k, v] of Object.entries(values)) {
          if (v != null) valuesRecord[k] = String(v);
        }
      }
      prompt.options.push({
        id,
        label: typeof optObj.label === "string" ? optObj.label : undefined,
        values: valuesRecord,
      });
    }
  }
  return prompt;
}

const STANDARD_PLACEHOLDERS = new Set([
  "project",
  "context",
  "environment",
  "date",
  "difficulty",
  "group",
  "projectName",
  "daily_nav",
]);

/** Подпись по умолчанию, если в шаблоне нет opa_labels. */
function defaultPlaceholderLabel(key: string): string {
  return key.replace(/_/g, " ");
}

/** Парсит opa_labels из сырого текста frontmatter (между ---). Не зависит от кэша Obsidian. */
function parseOpaLabelsFromContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const opaLabelsIdx = fm.search(/^opa_labels\s*:/m);
  if (opaLabelsIdx < 0) return out;
  const after = fm.slice(opaLabelsIdx);
  const lines = after.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s{2,}/.test(line) && line.trim() !== "") break;
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim();
    let v = line.slice(colon + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

/** Подпись для плейсхолдера: из текста шаблона (opa_labels в frontmatter) или из кэша, иначе по умолчанию. */
function getPlaceholderLabel(
  key: string,
  templateContent: string,
  fm: Record<string, unknown> | undefined
): string {
  const fromContent = parseOpaLabelsFromContent(templateContent)[key];
  if (fromContent) return fromContent;
  let opaLabels = fm?.opa_labels;
  if (typeof opaLabels === "string") {
    try {
      opaLabels = JSON.parse(opaLabels) as Record<string, unknown>;
    } catch {
      opaLabels = null;
    }
  }
  if (opaLabels && typeof opaLabels === "object" && !Array.isArray(opaLabels)) {
    const v = (opaLabels as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return defaultPlaceholderLabel(key);
}

/** Извлекает из текста шаблона уникальные плейсхолдеры %%key%% (кроме стандартных). */
function extractPlaceholdersFromContent(content: string): string[] {
  const set = new Set<string>();
  const re = /%%([^%]+)%%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const key = m[1].trim();
    if (key && !STANDARD_PLACEHOLDERS.has(key)) set.add(key);
  }
  return [...set].sort();
}

/** Загружает поля: opa_prompts из frontmatter + плейсхолдеры из текста. Frontmatter только из файла (parseYaml), кэш не используется. */
async function getTaskTemplatePrompts(
  app: App,
  templateKeys: string[]
): Promise<Map<string, OpaPrompt[]>> {
  const map = new Map<string, OpaPrompt[]>();
  const prefix = Paths.TASK_TEMPLATES_FOLDER + "/";
  for (const templateKey of templateKeys) {
    if (templateKey === "task") {
      map.set(templateKey, []);
      continue;
    }
    const path = `${prefix}${templateKey}.md`;
    const file = app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      map.set(templateKey, []);
      continue;
    }
    let list: OpaPrompt[] = [];
    try {
      const content = await app.vault.read(file);
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let fm: Record<string, unknown> = {};
      if (fmMatch) {
        try {
          const parsedFm = parseYaml(fmMatch[1]);
          if (parsedFm && typeof parsedFm === "object") {
            fm = parsedFm as Record<string, unknown>;
          }
        } catch {}
      }
      let rawList = fm?.opa_prompts;
      if (typeof rawList === "string") {
        try {
          rawList = JSON.parse(rawList) as unknown;
        } catch {
          rawList = null;
        }
      }
      if (!Array.isArray(rawList) && fmMatch) {
        const blockMatch = fmMatch[1].match(/\nopa_prompts:\s*\n([\s\S]*?)(?=\n\S|\n---|$)/);
        if (blockMatch) {
          try {
            const wrapped = "prompts:\n" + blockMatch[1].trimEnd();
            const parsed = parseYaml(wrapped) as { prompts?: unknown[] };
            if (Array.isArray(parsed?.prompts)) rawList = parsed.prompts;
          } catch {}
        }
      }
      const fromPrompts = new Map<string, OpaPrompt>();
      if (Array.isArray(rawList)) {
        for (const raw of rawList) {
          const p = parseOpaPrompt(raw);
          if (p) fromPrompts.set(p.key, p);
        }
      }
      const keys = extractPlaceholdersFromContent(content);
      for (const k of keys) {
        const fromOpa = fromPrompts.get(k);
        if (fromOpa) {
          list.push(fromOpa);
        } else {
          list.push({
            key: k,
            label: getPlaceholderLabel(k, content, fm),
            type: "text",
          });
        }
      }
      for (const p of fromPrompts.values()) {
        if (!keys.includes(p.key)) list.push(p);
      }
      const listKeys = new Set(list.map((x) => x.key));
      for (const p of list) {
        if (p.type === "suggester" && p.options) {
          for (const opt of p.options) {
            if (opt.values) {
              for (const k of Object.keys(opt.values)) {
                if (!listKeys.has(k)) {
                  listKeys.add(k);
                  list.push({
                    key: k,
                    label: getPlaceholderLabel(k, content, fm),
                    type: "text",
                  });
                }
              }
            }
          }
        }
      }
      list.sort((a, b) => a.key.localeCompare(b.key));
    } catch {}
    map.set(templateKey, list);
  }
  return map;
}

const DIFFICULTY_OPTIONS = ["Легко", "Средне", "Сложно"];
const DEFAULT_ENVIRONMENT_OPTIONS = ["prod", "dev"];

function parseCommaSeparatedOptions(value: string | undefined): string[] {
  if (!value || !String(value).trim()) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Удаляет строки, в которых остались неподставленные плейсхолдеры %%...%%. */
function removeLinesWithUnfilledPlaceholders(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/%%[^%]+%%/.test(line))
    .join("\n");
}

/** Удаляет из frontmatter контента поля opa_labels, opa_prompts, opa_project и opa_group (они только для шаблона). */
function stripOpaFrontmatterFromContent(content: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return content;
  try {
    const fm = parseYaml(fmMatch[1]) as Record<string, unknown> | null;
    if (!fm || typeof fm !== "object") return content;
    const { opa_labels: _l, opa_prompts: _p, opa_project: _proj, opa_group: _grp, ...rest } = fm;
    const newFm = stringifyYaml(rest).trimEnd();
    return content.replace(fmMatch[0], "---\n" + newFm + "\n---");
  } catch {
    return content;
  }
}

/** Удаляет блоки Templater (<%* ... %>, <% ... %> и т.д.), чтобы они не попадали в заметку как текст. */
function stripTemplaterBlocks(content: string): string {
  return content.replace(/<%\*?[\s\S]*?%>/g, "").trim();
}

/** Всплывающее окно мультивыбора: чекбоксы в списке, OK/Cancel. */
class MultiSelectModal extends Modal {
  constructor(
    app: App,
    private readonly titleText: string,
    private readonly options: string[],
    private readonly initialValue: string,
    private readonly onConfirm: (value: string) => void
  ) {
    super(app);
    this.setTitle(titleText);
  }

  onOpen(): void {
    this.modalEl.addClass("opa-multi-select-popover");
    const selected = new Set(
      this.initialValue
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const filterWrap = this.contentEl.createDiv({ cls: "opa-multi-select-filter" });
    const filterInput = filterWrap.createEl("input", {
      type: "text",
      attr: { placeholder: "Введите буквы для поиска…" },
    });
    const wrap = this.contentEl.createDiv({ cls: "opa-multi-select" });
    const labelEls: HTMLElement[] = [];
    for (const opt of this.options) {
      const label = wrap.createEl("label", { cls: "opa-multi-select-label" });
      const cb = label.createEl("input", { type: "checkbox", attr: { "data-value": opt } });
      cb.checked = selected.has(opt);
      if (selected.has(opt)) label.addClass("opa-multi-select-label-checked");
      cb.onchange = () => label.classList.toggle("opa-multi-select-label-checked", cb.checked);
      label.appendText(opt);
      labelEls.push(label);
    }
    const applyFilter = (q: string) => {
      const lower = q.trim().toLowerCase();
      labelEls.forEach((el) => {
        const value = (el.querySelector("input")?.dataset.value ?? "").toLowerCase();
        el.classList.toggle("opa-filter-hidden", !!lower && !value.includes(lower));
      });
    };
    filterInput.addEventListener("input", () => applyFilter(filterInput.value));
    const visibleLabels = () => labelEls.filter((el) => !el.classList.contains("opa-filter-hidden"));
    const focusLabel = (idx: number) => {
      const vis = visibleLabels();
      if (vis.length === 0) return;
      const i = Math.max(0, Math.min(idx, vis.length - 1));
      (vis[i].querySelector("input") as HTMLInputElement)?.focus();
    };
    this.modalEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        okBtn.click();
        return;
      }
      if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
        const vis = visibleLabels();
        if (vis.length === 0) return;
        const active = document.activeElement;
        let idx = vis.findIndex((el) => el.contains(active));
        if (idx < 0) idx = 0;
        else idx = evt.key === "ArrowDown" ? Math.min(idx + 1, vis.length - 1) : Math.max(idx - 1, 0);
        evt.preventDefault();
        focusLabel(idx);
      }
    });
    const btnRow = this.contentEl.createDiv({ cls: "opa-multi-select-buttons" });
    btnRow.createEl("button", { text: "Отмена" }).onclick = () => this.close();
    const okBtn = btnRow.createEl("button", { cls: "mod-cta", text: "OK" });
    okBtn.onclick = () => {
      const checked = wrap.querySelectorAll<HTMLInputElement>("input:checked");
      const value = [...checked].map((el) => el.dataset.value ?? "").filter(Boolean).join(", ");
      this.onConfirm(value);
      this.close();
    };
    this.modalEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        okBtn.click();
      }
    });
  }
}

function formatMultiSelectSummary(value: string): string {
  return value.trim();
}

function parseDayMonthYear(s: string): { day: number; month: number; year: number } | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const year = parseInt(m[3], 10);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  return { day, month, year };
}

function formatDDMMYYYY(d: Date): string {
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

const MONTH_NAMES_RU = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

function getDaysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

function prevNextDay(basename: string): { prev: string; next: string; folder: string } | null {
  const parsed = parseDayMonthYear(basename);
  if (!parsed) return null;
  const { day, month, year } = parsed;
  const date = new Date(year, month, day);
  const prev = new Date(date);
  prev.setDate(prev.getDate() - 1);
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return {
    prev: formatDDMMYYYY(prev),
    next: formatDDMMYYYY(next),
    folder: "",
  };
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

/** Модалка только «Задача» / «Проект» — для горячей клавиши «Создать задачу или проект». */
class CreateTaskOrProjectModal extends Modal {
  constructor(
    private ctx: ModuleContext,
    private onTask: () => void,
    private onProject: () => void
  ) {
    super(ctx.app);
    this.setTitle("");
  }

  onOpen(): void {
    this.modalEl.addClass("opa-new-note-modal");
    this.modalEl.addClass("opa-task-or-project-modal");
    const { contentEl } = this;
    const btnContainer = contentEl.createDiv({ cls: "opa-new-note-buttons" });
    const run = (fn: () => void) => {
      this.close();
      fn();
    };
    btnContainer.createEl("button", { text: "Задача", cls: "mod-secondary" }).onclick = () => run(this.onTask);
    btnContainer.createEl("button", { text: "Проект", cls: "mod-secondary" }).onclick = () => run(this.onProject);
  }
}

/** Выбор: создать задачу или проект (и другие типы заметок). */
class CreateNoteModal extends Modal {
  constructor(
    private ctx: ModuleContext,
    private onTask: () => void,
    private onProject: () => void,
    private onDaily: () => void,
    private onFromTemplate: () => void
  ) {
    super(ctx.app);
    this.setTitle("Новая заметка");
  }

  onOpen(): void {
    this.modalEl.addClass("opa-new-note-modal");
    const { contentEl } = this;
    contentEl.createEl("p", { text: "Создать задачу или проект?", cls: "opa-new-note-label" });
    const btnContainer = contentEl.createDiv({ cls: "opa-new-note-buttons" });
    const run = (fn: () => void) => {
      this.close();
      fn();
    };
    btnContainer.createEl("button", { text: "Задача", cls: "mod-cta" }).onclick = () => run(this.onTask);
    btnContainer.createEl("button", { text: "Проект", cls: "mod-cta" }).onclick = () => run(this.onProject);
    contentEl.createEl("p", { text: "Другое:", cls: "opa-new-note-label opa-new-note-label-secondary" });
    const otherContainer = contentEl.createDiv({ cls: "opa-new-note-buttons" });
    otherContainer.createEl("button", { text: "Ежедневная", cls: "mod-secondary" }).onclick = () => run(this.onDaily);
    otherContainer.createEl("button", { text: "По шаблону из папки templates", cls: "mod-secondary" }).onclick = () =>
      run(this.onFromTemplate);
  }
}

/** Заметка по выбранному файлу из templates/. */
class ChooseTemplateModal extends Modal {
  private templatePath = "";
  private name = "";
  private templatePaths: string[] = [];

  constructor(
    private ctx: ModuleContext,
    private onDone: (templatePath: string, name: string) => void
  ) {
    super(ctx.app);
    this.setTitle("Заметка по шаблону");
  }

  onOpen(): void {
    this.modalEl.addClass("opa-create-task-modal");
    const files = this.ctx.app.vault.getMarkdownFiles();
    const prefix = Paths.TEMPLATES_FOLDER + "/";
    this.templatePaths = files
      .filter((f) => f.path.startsWith(prefix) && f.path !== prefix)
      .map((f) => f.path)
      .sort();
    if (this.templatePaths.length === 0) {
      this.contentEl.createDiv({ text: "В папке templates/ нет .md файлов." });
      return;
    }
    this.templatePath = this.templatePaths[0];
    const { contentEl } = this;
    new Setting(contentEl)
      .setName("Шаблон")
      .addDropdown((d) => {
        for (const p of this.templatePaths) {
          const label = p.slice(prefix.length).replace(/\.md$/, "");
          d.addOption(p, label);
        }
        d.setValue(this.templatePath).onChange((v) => (this.templatePath = v));
      });
    new Setting(contentEl).setName("Имя заметки").addText((t) =>
      t.setPlaceholder("Название").onChange((v) => (this.name = v))
    );
    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Создать").onClick(() => {
        if (!this.name.trim()) {
          new Notice("Введите имя заметки.");
          return;
        }
        this.onDone(this.templatePath, this.name.trim());
        this.close();
      })
    );
  }
}

/** Окно выбора даты для заголовка в ежедневной (степперы месяц/год + день). */
class DailyHeadingDateModal extends Modal {
  private value = "";

  constructor(
    app: App,
    private readonly onDone: (value: string | null) => void
  ) {
    super(app);
    this.setTitle("Дата ежедневной заметки");
  }

  onOpen(): void {
    this.modalEl.addClass("opa-daily-heading-date-modal");
    const { contentEl } = this;
    const now = new Date();
    let selectedDay = now.getDate();
    let selectedMonth = now.getMonth() + 1;
    let selectedYear = now.getFullYear();
    const yearMin = 2020;
    const yearMax = selectedYear + 10;

    const clampDay = (): void => {
      const maxDay = getDaysInMonth(selectedYear, selectedMonth - 1);
      if (selectedDay > maxDay) selectedDay = maxDay;
    };

    const steppersWrap = contentEl.createDiv({ cls: "opa-daily-heading-date-steppers-wrap" });
    const monthWrap = steppersWrap.createDiv({ cls: "gamification-completed-month-wrap opa-daily-heading-date-steppers" });

    const dayGroup = monthWrap.createDiv({ cls: "gamification-month-group" });
    const dayStepper = dayGroup.createDiv({ cls: "gamification-stepper-group" });
    const dayPrev = dayStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" });
    const dayValue = dayStepper.createEl("span", { cls: "gamification-stepper-value" });
    const dayNext = dayStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" });

    const monthGroup = monthWrap.createDiv({ cls: "gamification-month-group" });
    const monthStepper = monthGroup.createDiv({ cls: "gamification-stepper-group" });
    const monthPrev = monthStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" });
    const monthValue = monthStepper.createEl("span", { cls: "gamification-stepper-value gamification-stepper-month" });
    const monthNext = monthStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" });

    const yearGroup = monthWrap.createDiv({ cls: "gamification-month-group" });
    const yearStepper = yearGroup.createDiv({ cls: "gamification-stepper-group" });
    const yearPrev = yearStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" });
    const yearValue = yearStepper.createEl("span", { cls: "gamification-stepper-value" });
    const yearNext = yearStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" });

    const updateLabels = (): void => {
      clampDay();
      dayValue.setText(String(selectedDay));
      monthValue.setText(MONTH_NAMES_RU[selectedMonth - 1] ?? "");
      yearValue.setText(String(selectedYear));
    };

    dayPrev.addEventListener("click", () => {
      if (selectedDay > 1) {
        selectedDay--;
      } else {
        if (selectedMonth === 1) {
          selectedMonth = 12;
          if (selectedYear > yearMin) selectedYear--;
        } else selectedMonth--;
        selectedDay = getDaysInMonth(selectedYear, selectedMonth - 1);
      }
      updateLabels();
    });
    dayNext.addEventListener("click", () => {
      const maxDay = getDaysInMonth(selectedYear, selectedMonth - 1);
      if (selectedDay < maxDay) {
        selectedDay++;
      } else {
        if (selectedMonth === 12) {
          selectedMonth = 1;
          if (selectedYear < yearMax) selectedYear++;
        } else selectedMonth++;
        selectedDay = 1;
      }
      updateLabels();
    });
    monthPrev.addEventListener("click", () => {
      if (selectedMonth === 1) {
        selectedMonth = 12;
        if (selectedYear > yearMin) selectedYear--;
      } else selectedMonth--;
      updateLabels();
    });
    monthNext.addEventListener("click", () => {
      if (selectedMonth === 12) {
        selectedMonth = 1;
        if (selectedYear < yearMax) selectedYear++;
      } else selectedMonth++;
      updateLabels();
    });
    yearPrev.addEventListener("click", () => {
      if (selectedYear > yearMin) {
        selectedYear--;
        updateLabels();
      }
    });
    yearNext.addEventListener("click", () => {
      if (selectedYear < yearMax) {
        selectedYear++;
        updateLabels();
      }
    });

    const currentDayRow = steppersWrap.createDiv({ cls: "opa-daily-heading-current-day-row" });
    const currentDayBtn = currentDayRow.createEl("button", {
      type: "button",
      cls: "gamification-stepper-current-btn",
      text: "Текущий день",
    });
    currentDayBtn.addEventListener("click", () => {
      selectedDay = now.getDate();
      selectedMonth = now.getMonth() + 1;
      selectedYear = now.getFullYear();
      updateLabels();
    });

    updateLabels();

    const btnRow = contentEl.createDiv({ cls: "opa-daily-heading-date-buttons" });
    const cancelBtn = btnRow.createEl("button", { text: "Отмена", cls: "mod-secondary" });
    const okBtn = btnRow.createEl("button", { text: "OK", cls: "mod-cta" });

    cancelBtn.onclick = () => {
      this.onDone(null);
      this.close();
    };

    okBtn.onclick = () => {
      clampDay();
      const dayStr = String(selectedDay).padStart(2, "0");
      const monthStr = String(selectedMonth).padStart(2, "0");
      this.value = `${dayStr}-${monthStr}-${selectedYear}`;
      this.onDone(this.value);
      this.close();
    };
  }
}

class CreateTaskModal extends Modal {
  private name = "";
  private project = "";
  private context = "";
  private environment = "";
  private dateMode: "today" | "choose" = "today";
  private dateChosen = "";
  private difficulty = "Легко";
  private group = "";
  private templateKey = "task";
  private dailyHeadingMode: "today" | "choose" | "none" = "today";
  private dailyHeadingDate = "";
  /** Дата дедлайна (только при enableDeadline). */
  private deadline = "";
  /** Значения полей opa_prompts для текущего шаблона. */
  private customPlaceholders: Record<string, string> = {};
  /** Сохранённые значения при переключении шаблона. */
  private customValuesByTemplate = new Map<string, Record<string, string>>();
  private customFieldsContainer: HTMLDivElement | null = null;
  /** Ссылка на элемент отображения выбранного проекта (для обновления при смене шаблона). */
  private projectSummaryEl: HTMLElement | null = null;
  /** Ссылка на поле ввода группы (для обновления при смене шаблона). */
  private groupInputRef: { setValue(v: string): void } | null = null;

  constructor(
    private ctx: ModuleContext,
    private onDone: (p: {
      name: string;
      project: string;
      context: string;
      environment: string;
      date: string;
      difficulty: string;
      group: string;
      templateKey: string;
      dailyHeadingMode: "today" | "choose" | "none";
      dailyHeadingDate: string;
      customPlaceholders: Record<string, string>;
      deadline?: string;
    }) => void,
    private meta: ExistingTaskMeta
  ) {
    super(ctx.app);
    this.setTitle("Создать задачу");
  }

  private renderCustomFields(): void {
    const container = this.customFieldsContainer;
    if (!container) return;
    container.empty();
    const prompts = this.meta.templatePrompts?.get(this.templateKey) ?? [];
    for (const prompt of prompts) {
      if (prompt.type === "suggester" && prompt.options?.length) {
        const opts = prompt.options;
        const first = opts[0];
        const matched = opts.some(
          (o) =>
            o.values &&
            Object.keys(o.values).every((k) => this.customPlaceholders[k] === o.values![k])
        );
        if (!matched && first?.values) {
          Object.assign(this.customPlaceholders, first.values);
        }
      }
    }
    for (const prompt of prompts) {
      if (prompt.type === "suggester" && prompt.options?.length) {
        const setting = new Setting(container).setName(prompt.label);
        const opts = prompt.options;
        let currentId = opts[0]?.id ?? "";
        for (const o of opts) {
          if (
            o.values &&
            Object.keys(o.values).every((k) => this.customPlaceholders[k] === o.values[k])
          ) {
            currentId = o.id;
            break;
          }
        }
        setting.addDropdown((d) => {
          for (const o of opts) {
            d.addOption(o.id, o.label ?? o.id);
          }
          d.setValue(currentId).onChange((id) => {
            const opt = opts.find((o) => o.id === id);
            if (opt?.values) {
              Object.assign(this.customPlaceholders, opt.values);
              this.renderCustomFields();
            }
          });
        });
      } else {
        const setting = new Setting(container).setName(prompt.label);
        const val = this.customPlaceholders[prompt.key] ?? "";
        setting.addText((t) =>
          t.setValue(val).setPlaceholder(prompt.label || "").onChange((v) => {
            this.customPlaceholders[prompt.key] = v;
          })
        );
      }
    }
    const section = container.parentElement;
    if (section) {
      section.classList.toggle("opa-create-task-custom-section-empty", container.childNodes.length === 0);
    }
  }

  private addMultiSelectRow(
    contentEl: HTMLElement,
    name: string,
    options: string[],
    getValue: () => string,
    setValue: (v: string) => void,
    onSummaryCreated?: (summaryEl: HTMLElement) => void
  ): void {
    const setting = new Setting(contentEl).setName(name);
    const wrap = setting.controlEl.createDiv({ cls: "opa-multi-select-row" });
    const summary = wrap.createSpan({ cls: "opa-multi-select-summary" });
    summary.setText(formatMultiSelectSummary(getValue()));
    onSummaryCreated?.(summary);
    const btn = wrap.createEl("button", { cls: "mod-secondary", text: "Выбрать…" });
    btn.onclick = () => {
      const modal = new MultiSelectModal(
        this.app,
        name,
        options,
        getValue(),
        (v) => {
          setValue(v);
          summary.setText(formatMultiSelectSummary(v));
        }
      );
      modal.open();
    };
  }

  onOpen(): void {
    this.modalEl.addClass("opa-create-task-modal");
    const initialName = (this.meta as { initialName?: string }).initialName;
    if (initialName != null) this.name = initialName;
    const { contentEl } = this;
    const meta = this.meta;
    const form = contentEl.createDiv({ cls: "opa-create-task-form" });
    form.style.width = "100%";
    form.style.minWidth = "450px";
    form.style.boxSizing = "border-box";

    new Setting(form)
      .setName("Шаблон")
      .addDropdown((d) => {
        for (const { key, label } of meta.taskTemplates) {
          d.addOption(key, label);
        }
        const current =
          meta.taskTemplates.some((t) => t.key === this.templateKey) ? this.templateKey : "task";
        d.setValue(current).onChange((v) => {
          if (this.customFieldsContainer) {
            this.customValuesByTemplate.set(this.templateKey, { ...this.customPlaceholders });
            this.templateKey = v;
            const restored = this.customValuesByTemplate.get(v);
            this.customPlaceholders = restored ? { ...restored } : {};
            this.renderCustomFields();
          } else {
            this.templateKey = v;
          }
          const template = meta.taskTemplates.find((t) => t.key === v);
          if (template?.defaultProject) {
            const fromList = meta.projects.find(
              (p) => p.toLowerCase() === template.defaultProject!.toLowerCase()
            );
            this.project = fromList ?? template.defaultProject;
          } else {
            this.project = "";
          }
          if (template?.defaultGroup) {
            this.group = template.defaultGroup;
          } else {
            this.group = "";
          }
          if (this.projectSummaryEl) {
            this.projectSummaryEl.setText(formatMultiSelectSummary(this.project));
          }
          if (this.groupInputRef) {
            this.groupInputRef.setValue(this.group);
          }
        });
      });
    const initialTemplate = meta.taskTemplates.find((t) => t.key === this.templateKey);
    if (initialTemplate?.defaultProject) {
      const fromList = meta.projects.find(
        (p) => p.toLowerCase() === initialTemplate.defaultProject!.toLowerCase()
      );
      this.project = fromList ?? initialTemplate.defaultProject;
    }
    if (initialTemplate?.defaultGroup) {
      this.group = initialTemplate.defaultGroup;
    }
    new Setting(form).setName("Название").addText((t) =>
      t.setPlaceholder("Название").setValue(this.name).onChange((v) => (this.name = v))
    );
    const contextOpts = parseCommaSeparatedOptions(this.ctx.plugin.settings.contextOptions);
    const contextList = contextOpts.length > 0 ? contextOpts : meta.contexts;
    const envOpts = parseCommaSeparatedOptions(this.ctx.plugin.settings.environmentOptions);
    const environmentList = envOpts.length > 0 ? envOpts : DEFAULT_ENVIRONMENT_OPTIONS;

    this.addMultiSelectRow(
      form,
      "Проект",
      meta.projects,
      () => this.project,
      (v) => (this.project = v),
      (summaryEl) => {
        this.projectSummaryEl = summaryEl;
      }
    );
    this.addMultiSelectRow(form, "Контекст", contextList, () => this.context, (v) => (this.context = v));
    this.addMultiSelectRow(form, "Окружение", environmentList, () => this.environment, (v) => (this.environment = v));
    const dateSetting = new Setting(form).setName("Дата");
    const dateWrap = dateSetting.controlEl.createDiv({ cls: "opa-multi-select-row" });
    const dateSummary = dateWrap.createSpan({ cls: "opa-multi-select-summary" });
    const getDateSummary = (): string => {
      if (this.dateMode === "today") return formatDDMMYYYY(new Date());
      return this.dateChosen || "Выбрать день";
    };
    dateSummary.setText(getDateSummary());
    const dateDropdown = dateWrap.createEl("select", { cls: "dropdown" });
    dateDropdown.createEl("option", { value: "today", text: "Сегодняшний день" });
    dateDropdown.createEl("option", { value: "choose", text: "Выбрать день" });
    dateDropdown.value = this.dateMode;
    dateDropdown.addEventListener("change", () => {
      const newMode = dateDropdown.value as "today" | "choose";
      if (newMode === "choose") {
        this.dateMode = "choose";
        dateSummary.setText(getDateSummary());
        const modal = new DailyHeadingDateModal(this.app, (value) => {
          if (value) {
            this.dateMode = "choose";
            this.dateChosen = value;
            dateDropdown.value = "choose";
            dateSummary.setText(getDateSummary());
          } else {
            this.dateMode = "today";
            this.dateChosen = "";
            dateDropdown.value = "today";
            dateSummary.setText(getDateSummary());
          }
        });
        modal.open();
      } else {
        this.dateMode = "today";
        this.dateChosen = "";
        dateSummary.setText(getDateSummary());
      }
    });
    if (this.ctx.plugin.settings.enableGamification) {
      new Setting(form)
        .setName("Сложность")
        .addDropdown((d) => {
          d.addOption("", "—");
          for (const v of DIFFICULTY_OPTIONS) d.addOption(v, v);
          d.setValue(this.difficulty).onChange((v) => (this.difficulty = v));
        });
    }
    new Setting(form)
      .setName("Группа")
      .addText((t) => {
        this.groupInputRef = t;
        t.setPlaceholder("Группа")
          .setValue(this.group)
          .onChange((v) => (this.group = v));
      });
    if (this.ctx.plugin.settings.enableDeadline) {
      const deadlineSetting = new Setting(form).setName("Дедлайн");
      const deadlineWrap = deadlineSetting.controlEl.createDiv({ cls: "opa-multi-select-row" });
      const deadlineSummary = deadlineWrap.createSpan({ cls: "opa-multi-select-summary" });
      deadlineSummary.setText(this.deadline || "Не указан");
      const setDeadlineSummary = (): void => {
        deadlineSummary.setText(this.deadline || "Не указан");
      };
      const openDeadlineModal = (): void => {
        const modal = new DailyHeadingDateModal(this.app, (value) => {
          if (value) {
            this.deadline = value;
            setDeadlineSummary();
          }
        });
        modal.open();
      };
      const btn = deadlineWrap.createEl("button", { text: "Выбрать дату", cls: "mod-secondary" });
      btn.addEventListener("click", openDeadlineModal);
    }
    const customSection = form.createDiv({ cls: "opa-create-task-custom-section" });
    customSection.createEl("hr", { cls: "opa-create-task-custom-divider" });
    this.customFieldsContainer = customSection.createDiv({ cls: "opa-create-task-custom-fields" });
    this.renderCustomFields();
    let lastMode: "today" | "choose" | "none" = this.dailyHeadingMode;
    const headingSetting = new Setting(form).setName("Заголовок");
    const headingWrap = headingSetting.controlEl.createDiv({ cls: "opa-multi-select-row" });
    const headingSummary = headingWrap.createSpan({ cls: "opa-multi-select-summary" });
    const formatDateForSummary = (): string => {
      const d = new Date();
      return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
    };
    const getHeadingSummary = (): string => {
      if (this.dailyHeadingMode === "none") return "";
      if (this.dailyHeadingMode === "today") return formatDateForSummary();
      if (this.dailyHeadingMode === "choose") return this.dailyHeadingDate || "Выбрать день";
      return "";
    };
    headingSummary.setText(getHeadingSummary());
    const headingDropdown = headingWrap.createEl("select", { cls: "dropdown" });
    headingDropdown.createEl("option", { value: "none", text: "Не создавать заголовок" });
    headingDropdown.createEl("option", { value: "today", text: "Сегодняшний день" });
    headingDropdown.createEl("option", { value: "choose", text: "Выбрать день" });
    headingDropdown.value = this.dailyHeadingMode;
    headingDropdown.addEventListener("change", () => {
      const newMode = headingDropdown.value as "today" | "choose" | "none";
      if (newMode === "choose") {
        const modal = new DailyHeadingDateModal(this.app, (value) => {
          if (value) {
            this.dailyHeadingMode = "choose";
            this.dailyHeadingDate = value;
            lastMode = "choose";
            headingDropdown.value = "choose";
            headingSummary.setText(getHeadingSummary());
          } else {
            this.dailyHeadingMode = lastMode;
            this.dailyHeadingDate = this.dailyHeadingMode === "choose" ? this.dailyHeadingDate : "";
            headingDropdown.value = lastMode;
            headingSummary.setText(getHeadingSummary());
          }
        });
        modal.open();
      } else {
        this.dailyHeadingMode = newMode;
        if (newMode !== "choose") this.dailyHeadingDate = "";
        lastMode = newMode;
        headingSummary.setText(getHeadingSummary());
      }
    });
    const btnRow = form.createDiv({ cls: "opa-create-task-buttons" });
    btnRow.createEl("button", { text: "Отмена", cls: "mod-secondary" }).onclick = () => this.close();
    const createBtn = btnRow.createEl("button", { text: "Создать", cls: "mod-cta" });
    createBtn.onclick = () => {
      if (!this.name.trim()) {
        new Notice("Введите название.");
        return;
      }
      this.onDone({
        name: this.name.trim(),
        project: this.project,
        context: this.context,
        environment: this.environment,
        date: this.dateMode === "today" ? "" : this.dateChosen,
        difficulty: this.ctx.plugin.settings.enableGamification ? this.difficulty : "",
        group: this.group,
        templateKey: this.templateKey,
        dailyHeadingMode: this.dailyHeadingMode,
        dailyHeadingDate: this.dailyHeadingDate,
        customPlaceholders: { ...this.customPlaceholders },
        deadline: this.ctx.plugin.settings.enableDeadline ? this.deadline : undefined,
      });
      this.close();
    };
    const onEnter = (evt: KeyboardEvent) => {
      if (evt.key !== "Enter") return;
      if (!this.modalEl.isConnected) return;
      const active = document.activeElement;
      if (active?.matches("input, textarea, select, button")) return;
      if (active && active !== document.body && !this.modalEl.contains(active)) return;
      evt.preventDefault();
      evt.stopPropagation();
      createBtn.click();
    };
    document.addEventListener("keydown", onEnter, true);
    const originalOnClose = this.onClose.bind(this);
    this.onClose = () => {
      document.removeEventListener("keydown", onEnter, true);
      originalOnClose();
    };
  }
}

class CreateProjectModal extends Modal {
  private name = "";

  constructor(
    private ctx: ModuleContext,
    private onDone: (p: { name: string }) => void
  ) {
    super(ctx.app);
    this.setTitle("Создать проект");
  }

  onOpen(): void {
    this.modalEl.addClass("opa-create-task-modal");
    const { contentEl } = this;
    const form = contentEl.createDiv({ cls: "opa-create-task-form" });
    new Setting(form).setName("Имя проекта").addText((t) =>
      t.setPlaceholder("Название").onChange((v) => (this.name = v))
    );
    const btnRow = form.createDiv({ cls: "opa-create-task-buttons" });
    btnRow.createEl("button", { text: "Отмена", cls: "mod-secondary" }).onclick = () => this.close();
    const createBtn = btnRow.createEl("button", { text: "Создать", cls: "mod-cta" });
    createBtn.onclick = () => {
      if (!this.name.trim()) {
        new Notice("Введите имя проекта.");
        return;
      }
      this.onDone({ name: this.name.trim() });
      this.close();
    };
    const onEnter = (evt: KeyboardEvent) => {
      if (evt.key !== "Enter") return;
      if (!this.modalEl.isConnected) return;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !this.modalEl.contains(active)) return;
      if (active.closest?.("button") && active.textContent?.trim() === "Отмена") return;
      evt.preventDefault();
      evt.stopPropagation();
      createBtn.click();
    };
    document.addEventListener("keydown", onEnter, true);
    const originalOnClose = this.onClose.bind(this);
    this.onClose = () => {
      document.removeEventListener("keydown", onEnter, true);
      originalOnClose();
    };
  }
}

const DAILY_FILENAME_REGEX = /^\d{2}-\d{2}-\d{4}\.md$/;

export class NoteTemplatesModule {
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
      setTimeout(async () => {
        try {
          const content = await this.ctx.app.vault.read(file);
          if (content.includes("%%daily_nav%%")) {
            const resolved = content.replace(/%%daily_nav%%/g, buildDailyNavLine(dateStr));
            await this.ctx.app.vault.modify(file, resolved);
            return;
          }
          if (content.trim() !== "") return;
          const newContent = await this.getDailyNoteContentForDate(dateStr);
          await this.ctx.app.vault.modify(file, newContent);
        } catch {}
      }, 0);
    };
    this.ctx.app.vault.on("create", this.onDailyCreated);

    this.ctx.plugin.addCommand({
      id: "create-task-or-project",
      name: "Создать задачу или проект",
      callback: () => this.openCreateTaskOrProject(),
    });
    this.ctx.plugin.addCommand({
      id: "create-task",
      name: "Создать задачу",
      callback: () => this.openCreateTask(),
    });
    this.ctx.plugin.addCommand({
      id: "create-project",
      name: "Создать проект",
      callback: () => this.openCreateProject(),
    });
    this.ctx.plugin.addCommand({
      id: "create-daily-note",
      name: "Создать ежедневную заметку",
      callback: () => this.createDailyNote(),
    });
    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-daily-nav", (_source, el) => {
      this.renderDailyNav(el);
    });
  }

  unload(): void {
    if (this.onDailyCreated) {
      this.ctx.app.vault.off("create", this.onDailyCreated);
      this.onDailyCreated = null;
    }
  }

  private openCreateTaskOrProject(): void {
    const modal = new CreateTaskOrProjectModal(this.ctx, () => this.openCreateTask(), () => this.openCreateProject());
    modal.open();
  }

  private openCreateNote(): void {
    const modal = new CreateNoteModal(
      this.ctx,
      () => this.openCreateTask(),
      () => this.openCreateProject(),
      () => this.createDailyNote(),
      () => this.openChooseTemplate()
    );
    modal.open();
  }

  private openChooseTemplate(): void {
    const modal = new ChooseTemplateModal(this.ctx, (templatePath, name) =>
      this.createFromTemplate(templatePath, name)
    );
    modal.open();
  }

  /** Создаёт папку templates/task-templates и файл-пример task-example.md, если его ещё нет. Вызывается из команды и из настроек. */
  async createExampleTaskTemplate(): Promise<void> {
    const folder = Paths.TASK_TEMPLATES_FOLDER;
    const path = `${folder}/${DEFAULT_TASK_TEMPLATE_EXAMPLE_FILENAME}`;
    const existing = this.ctx.app.vault.getAbstractFileByPath(path);
    if (existing) {
      new Notice("Пример шаблона уже есть: " + path);
      return;
    }
    let current = "";
    for (const part of folder.split("/")) {
      current += (current ? "/" : "") + part;
      if (!this.ctx.app.vault.getAbstractFileByPath(current)) {
        await this.ctx.app.vault.createFolder(current);
      }
    }
    await this.ctx.app.vault.create(path, DEFAULT_TASK_TEMPLATE_EXAMPLE);
    new Notice("Создан пример шаблона задачи: " + path);
  }

  /** Открыть модалку создания задачи. options.defaultName — предзаполнить название; options.onSuccess — вызвать после успешного создания. */
  async openCreateTask(options?: {
    defaultName?: string;
    onSuccess?: () => void | Promise<void>;
  }): Promise<void> {
    const [projects, taskTemplates] = await Promise.all([
      this.ctx.plugin.getProjectsSortedByTaskCount(),
      getTaskTemplatesList(this.ctx.app),
    ]);
    const templatePrompts = await getTaskTemplatePrompts(
      this.ctx.app,
      taskTemplates.map((t) => t.key)
    );
    const meta: ExistingTaskMeta & { initialName?: string } = {
      ...getExistingTaskMeta(this.ctx.app),
      projects,
      taskTemplates,
      templatePrompts,
      initialName: options?.defaultName,
    };
    const onDone = (p: {
      name: string;
      project: string;
      context: string;
      environment: string;
      date: string;
      difficulty: string;
      group: string;
      templateKey: string;
      dailyHeadingMode: "today" | "choose" | "none";
      dailyHeadingDate: string;
      customPlaceholders: Record<string, string>;
      deadline?: string;
    }) => {
      void this.createTask(p).then(async () => {
        await options?.onSuccess?.();
      });
    };
    const modal = new CreateTaskModal(this.ctx, onDone, meta);
    modal.open();
  }

  private openCreateProject(): void {
    const modal = new CreateProjectModal(this.ctx, (p) => this.createProject(p));
    modal.open();
  }

  private async createFromTemplate(templatePath: string, name: string): Promise<void> {
    const file = this.ctx.app.vault.getAbstractFileByPath(templatePath);
    if (!file) {
      new Notice("Шаблон не найден: " + templatePath);
      return;
    }
    let content = await this.ctx.app.vault.read(file);
    content = content.replace(/%%projectName%%/g, name).replace(/%%project%%/g, name);
    const safeName = name.replace(/[/\\]/g, "-") + ".md";
    const path = safeName;
    const created = await this.ctx.app.vault.create(path, content);
    new Notice(`Создана заметка: ${name}`);
    await this.ctx.app.workspace.getLeaf(true).openFile(created);
  }

  private async getTaskTemplateContent(key: string): Promise<string> {
    if (key === "task") {
      const file = this.ctx.app.vault.getAbstractFileByPath(Paths.TASK_TEMPLATE_PATH);
      if (file) return await this.ctx.app.vault.read(file);
      return DEFAULT_TASK;
    }
    const path = `${Paths.TASK_TEMPLATES_FOLDER}/${key}.md`;
    const file = this.ctx.app.vault.getAbstractFileByPath(path);
    if (!file) return "";
    return await this.ctx.app.vault.read(file);
  }

  /** Одно значение — как есть; несколько через запятую — YAML-массив для фронтматтера (project, context, environment). */
  private formatYamlList(valueStr: string): string {
    const parts = (valueStr ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return "\n" + parts.map((p) => `  - ${p}`).join("\n");
  }

  private async getProjectTemplateContent(): Promise<string> {
    const file = this.ctx.app.vault.getAbstractFileByPath(Paths.PROJECT_TEMPLATE_PATH);
    if (file) return await this.ctx.app.vault.read(file);
    return DEFAULT_PROJECT;
  }

  private async getDailyTemplateContent(): Promise<string> {
    const file = this.ctx.app.vault.getAbstractFileByPath(Paths.DAILY_TEMPLATE_PATH);
    if (file) return await this.ctx.app.vault.read(file);
    return DEFAULT_DAILY;
  }

  private async createTask(p: {
    name: string;
    project: string;
    context: string;
    environment: string;
    date: string;
    difficulty: string;
    group: string;
    templateKey: string;
    dailyHeadingMode: "today" | "choose" | "none";
    dailyHeadingDate: string;
    customPlaceholders: Record<string, string>;
    deadline?: string;
  }): Promise<void> {
    const resolvedDate = p.date.trim() || formatDDMMYYYY(new Date());
    let content = await this.getTaskTemplateContent(p.templateKey);
    if (!content && p.templateKey !== "task") {
      new Notice(`Шаблон не найден: ${Paths.TASK_TEMPLATES_FOLDER}/${p.templateKey}.md`);
      return;
    }
    if (!content) content = DEFAULT_TASK;
    content = content
      .replace(/%%project%%/g, this.formatYamlList(p.project))
      .replace(/%%context%%/g, this.formatYamlList(p.context))
      .replace(/%%environment%%/g, this.formatYamlList(p.environment))
      .replace(/%%date%%/g, resolvedDate)
      .replace(/%%difficulty%%/g, p.difficulty)
      .replace(/%%group%%/g, p.group);
    const enableDeadline = this.ctx.plugin.settings.enableDeadline ?? false;
    if (enableDeadline) {
      const deadlineVal = p.deadline ?? "";
      if (content.includes("%%deadline%%")) {
        content = content.replace(/%%deadline%%/g, deadlineVal);
      } else {
        content = content.replace(
          /(\ndate:\s*[^\n]+)(\r?\n)/m,
          (_, dateLine, nl) => `${dateLine}${nl}deadline: "${deadlineVal}"${nl}`
        );
      }
    } else {
      content = content.replace(/\n?\s*deadline:\s*["']?%%deadline%%["']?\s*\r?\n?/g, "\n");
    }
    for (const [k, v] of Object.entries(p.customPlaceholders ?? {})) {
      if (v != null && v !== "") {
        content = content.replace(new RegExp(`%%${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}%%`, "g"), v);
      }
    }
    content = content.replace(/```dataviewjs[\s\S]*?```/g, "```opa-task-view\n```");
    content = removeLinesWithUnfilledPlaceholders(content);
    content = stripOpaFrontmatterFromContent(content);

    const safeName = p.name.replace(/[/\\]/g, "-") + ".md";
    const path = safeName;
    const file = await this.ctx.app.vault.create(path, content);
    new Notice(`Создана задача: ${p.name}`);
    await this.ctx.app.workspace.getLeaf(true).openFile(file);
    this.ctx.plugin.tasksDashboard?.scheduleRefresh();
    await this.ensureDailyHeading(p.name, p.dailyHeadingMode, p.dailyHeadingDate);
    if (
      enableDeadline &&
      p.deadline?.trim() &&
      this.ctx.plugin.settings.enableReminders &&
      (this.ctx.plugin.settings.enableDeadlineReminders ?? true)
    ) {
      const parsed = parseDayMonthYear(p.deadline.trim());
      if (parsed) {
        const deadlineDate = new Date(
          parsed.year,
          parsed.month,
          parsed.day,
          10,
          0
        );
        const leadDays = Math.max(
          0,
          this.ctx.plugin.settings.deadlineReminderLeadDays ?? 1
        );
        const reminderDate = new Date(deadlineDate);
        reminderDate.setDate(reminderDate.getDate() - leadDays);
        const reminderLine = `- [ ] Дедлайн по задаче: ${p.name} ${formatReminderDateTag(reminderDate)}`;
        const data = await readDataFile(this.ctx.plugin);
        const reminders = [...(data.reminders ?? []), reminderLine];
        await writeDataFile(this.ctx.plugin, { reminders });
        await this.ctx.plugin.remindersIndex.refreshDataJson();
        this.ctx.plugin.reminders?.updateState?.();
      }
    }
  }

  private async createProject(p: { name: string }): Promise<void> {
    let content = await this.getProjectTemplateContent();
    content = content.replace(/%%projectName%%/g, p.name);
    content = content.replace(/```dataviewjs[\s\S]*?```/g, "```opa-project-view\n```");

    const path = p.name.endsWith(".md") ? p.name : p.name + ".md";
    const parts = path.split("/");
    if (parts.length > 1) {
      let current = "";
      for (let i = 0; i < parts.length - 1; i++) {
        current += (current ? "/" : "") + parts[i];
        if (!this.ctx.app.vault.getAbstractFileByPath(current)) {
          await this.ctx.app.vault.createFolder(current);
        }
      }
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

  private async ensureDailyHeading(
    taskName: string,
    mode: "today" | "choose" | "none",
    dateStr: string
  ): Promise<void> {
    if (mode === "none") return;

    let targetDate = "";
    if (mode === "today") {
      targetDate = formatDDMMYYYY(new Date());
    } else if (mode === "choose") {
      targetDate = dateStr.trim();
      if (!parseDayMonthYear(targetDate)) return;
    }
    if (!targetDate) return;

    const dailyFolder = Paths.DAILY_FOLDER.replace(/\/?$/, "");
    const path = `${dailyFolder}/${targetDate}.md`;
    const existing = this.ctx.app.vault.getAbstractFileByPath(path);

    let file: TFile;
    if (existing && existing instanceof TFile) {
      file = existing;
    } else {
      const content = await this.getDailyNoteContentForDate(targetDate);
      file = await this.ctx.app.vault.create(path, content);
      new Notice(`Создана ежедневная заметка: ${targetDate}`);
    }

    const headingToAdd = `### [[${taskName}]]`;
    const dailyNoteContent = await this.ctx.app.vault.read(file);
    if (dailyNoteContent.includes(headingToAdd)) return;

    let prefix = "";
    const trimmedContent = dailyNoteContent.trim();
    if (trimmedContent.length > 0) {
      const isJustNavBar =
        trimmedContent.includes("←") &&
        trimmedContent.includes("→") &&
        trimmedContent.split("\n").length === 1;
      if (isJustNavBar) {
        prefix = dailyNoteContent.endsWith("\n") ? "" : "\n";
      } else if (dailyNoteContent.endsWith("\n\n")) {
        prefix = "";
      } else if (dailyNoteContent.endsWith("\n")) {
        prefix = "\n";
      } else {
        prefix = "\n\n";
      }
    }

    await this.ctx.app.vault.modify(file, dailyNoteContent + `${prefix}${headingToAdd}\n`);
  }

  private async createDailyNote(): Promise<void> {
    const dateStr = formatDDMMYYYY(new Date());
    const path = `${Paths.DAILY_FOLDER}/${dateStr}.md`;
    const existing = this.ctx.app.vault.getAbstractFileByPath(path);
    if (existing) {
      await this.ctx.app.workspace.getLeaf(true).openFile(existing);
      new Notice("Ежедневная заметка уже существует.");
      return;
    }
    const content = await this.getDailyNoteContentForDate(dateStr);
    const file = await this.ctx.app.vault.create(path, content);
    new Notice(`Создана ежедневная заметка: ${dateStr}`);
    await this.ctx.app.workspace.getLeaf(true).openFile(file);
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
