/**
 * Формы создания заметок: «Создать задачу» (шаблон, название, проект/контекст/окружение, даты, сложность,
 * статус, группа, дедлайн, дата ежедневной заметки), «Создать проект» и окно мультивыбора.
 * Связь дат и фильтр мультивыбора без DOM - в CreateTaskFormState (покрыты тестами).
 */

import { Modal, Setting, type App } from "obsidian";
import type { ModuleContext } from "../modules/types";
import { formatDateDDMMYYYY, parseDDMMYYYY } from "../core/DateUtils";
import { getDropdownOptions } from "../core/StatusConfig";
import { UI_LABELS } from "./Labels";
import { DatePickerModal } from "./DatePickerModal";
import { matchProjectsInList } from "../core/InboxLinks";
import {
  CHOSEN_DAY_OPTION,
  dailyHeadingDropdownValue,
  dailyHeadingFollowingTaskDate,
  isMultiSelectOptionVisible,
  taskDateDropdownValue,
  taskDateKey,
  type DailyHeadingState,
  type TaskDateState,
} from "./CreateTaskFormState";

export interface TaskTemplateOption {
  key: string;
  label: string;
  /** Проект по умолчанию для этого шаблона (из opa_project во frontmatter). */
  defaultProject?: string;
  /** Группа по умолчанию для этого шаблона (из opa_group во frontmatter). */
  defaultGroup?: string;
}

export interface ExistingTaskMeta {
  projects: string[];
  contexts: string[];
  environments: string[];
  difficulties: string[];
  taskTemplates: TaskTemplateOption[];
  /** Название, с которым открыть форму (из блокнота или из строки ежедневной заметки). */
  initialName?: string;
  /**
   * Дата DD-MM-YYYY, с которой открыть «Дата задачи» и «Дата ежедневной заметки»
   * (команда из строки ежедневной заметки берёт её из имени файла). Сегодняшняя дата даёт режим «Сегодняшний день».
   */
  initialDate?: string;
  /** Проект(ы) через запятую, с которыми открыть форму (из привязки записи блокнота). */
  initialProject?: string;
}

/** Результат формы «Создать задачу». */
export interface CreateTaskFormResult {
  name: string;
  project: string;
  context: string;
  environment: string;
  /** Дата задачи DD-MM-YYYY; пустая строка - сегодня. */
  date: string;
  difficulty: string;
  status: string;
  group: string;
  templateKey: string;
  dailyHeadingMode: "today" | "choose" | "none";
  dailyHeadingDate: string;
  deadline?: string;
}

const DIFFICULTY_OPTIONS = ["Легко", "Средне", "Сложно"];
const DEFAULT_ENVIRONMENT_OPTIONS = ["prod", "dev"];

export function parseCommaSeparatedOptions(value: string | undefined): string[] {
  if (!value || !String(value).trim()) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Всплывающее окно мультивыбора: чекбоксы в списке, OK/Cancel. */
class MultiSelectModal extends Modal {
  constructor(
    app: App,
    titleText: string,
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
    /**
     * Фильтр по подстроке; отмеченные пункты при поиске не скрываем (см. isMultiSelectOptionVisible).
     * Снятый во время поиска пункт остаётся на экране до следующего изменения строки поиска,
     * чтобы случайное снятие можно было вернуть.
     */
    const applyFilter = (q: string) => {
      labelEls.forEach((el) => {
        const cb = el.querySelector("input");
        const visible = isMultiSelectOptionVisible(cb?.dataset.value ?? "", cb?.checked === true, q);
        el.classList.toggle("opa-filter-hidden", !visible);
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
  }
}

function formatMultiSelectSummary(value: string): string {
  return value.trim();
}

/**
 * Скрытый пункт «дата выбрана» для <select> с пунктом-действием «Выбрать день» (см. CHOSEN_DAY_OPTION):
 * в списке не показывается, но именно он выбран, когда дата уже задана, - «Выбрать день» остаётся
 * обычным пунктом, и его повторный выбор снова открывает окно даты.
 */
function addChosenDayOption(select: HTMLSelectElement): HTMLOptionElement {
  const option = select.createEl("option", { value: CHOSEN_DAY_OPTION, text: "Выбрать день" });
  option.hidden = true;
  return option;
}

/** Окно выбора дня для поля формы: значения - DD-MM-YYYY, null - отмена (Esc, клик вне окна, «Отмена»). */
function pickDay(app: App, title: string, initial: string, onDone: (value: string | null) => void): void {
  new DatePickerModal(app, {
    title,
    initial: initial ? parseDDMMYYYY(initial) : null,
    onDone: (date) => onDone(date ? formatDateDDMMYYYY(date) : null),
  }).open();
}

export class CreateTaskModal extends Modal {
  private name = "";
  private project = "";
  private context = "";
  private environment = "";
  private dateMode: "today" | "choose" = "today";
  private dateChosen = "";
  private difficulty = "Легко";
  /** Статус задачи: пустая строка = без статуса. */
  private status: string = UI_LABELS.tasks.defaultStatus;
  private group = "";
  private templateKey = "task";
  private dailyHeadingMode: "today" | "choose" | "none" = "today";
  private dailyHeadingDate = "";
  /** Дата дедлайна (только при enableDeadline). */
  private deadline = "";
  /** Ссылка на элемент отображения выбранного проекта (для обновления при смене шаблона). */
  private projectSummaryEl: HTMLElement | null = null;
  /** Ссылка на поле ввода группы (для обновления при смене шаблона). */
  private groupInputRef: { setValue(v: string): void } | null = null;
  private errorEl: HTMLElement | null = null;

  constructor(
    private ctx: ModuleContext,
    private onDone: (p: CreateTaskFormResult) => Promise<void>,
    private meta: ExistingTaskMeta
  ) {
    super(ctx.app);
    this.setTitle("Создать задачу");
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
    if (this.meta.initialName != null) this.name = this.meta.initialName;
    if (
      this.meta.initialDate &&
      parseDDMMYYYY(this.meta.initialDate) &&
      this.meta.initialDate !== formatDateDDMMYYYY(new Date())
    ) {
      this.dateMode = "choose";
      this.dateChosen = this.meta.initialDate;
      this.dailyHeadingMode = "choose";
      this.dailyHeadingDate = this.meta.initialDate;
    }
    const { contentEl } = this;
    const meta = this.meta;
    // Ширину и прокрутку задаёт CSS (.opa-create-task-modal): без фиксированных пикселей форма помещается и на телефоне
    const form = contentEl.createDiv({ cls: "opa-create-task-form" });

    new Setting(form)
      .setName("Шаблон задачи")
      .addDropdown((d) => {
        for (const { key, label } of meta.taskTemplates) {
          d.addOption(key, label);
        }
        const current =
          meta.taskTemplates.some((t) => t.key === this.templateKey) ? this.templateKey : "task";
        d.setValue(current).onChange((v) => {
          this.templateKey = v;
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
    // Проект из привязки записи блокнота точнее проекта шаблона по умолчанию. Смена шаблона ставит проект шаблона.
    if (meta.initialProject?.trim()) {
      this.project = matchProjectsInList(meta.initialProject, meta.projects);
    }
    let nameInput: HTMLInputElement | null = null;
    new Setting(form).setName("Название задачи").addText((t) => {
      nameInput = t.inputEl;
      t.setPlaceholder("Название задачи").setValue(this.name).onChange((v) => {
        this.name = v;
        this.errorEl?.hide();
      });
    });
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
    const dateSetting = new Setting(form).setName("Дата задачи");
    const dateWrap = dateSetting.controlEl.createDiv({ cls: "opa-multi-select-row" });
    const dateSummary = dateWrap.createSpan({ cls: "opa-multi-select-summary" });
    const getDateSummary = (): string => {
      if (this.dateMode === "today") return formatDateDDMMYYYY(new Date());
      return this.dateChosen || "Выбрать день";
    };
    dateSummary.setText(getDateSummary());
    const dateDropdown = dateWrap.createEl("select", { cls: "dropdown" });
    dateDropdown.createEl("option", { value: "today", text: "Сегодняшний день" });
    dateDropdown.createEl("option", { value: "choose", text: "Выбрать день" });
    addChosenDayOption(dateDropdown);
    const currentTaskDate = (): TaskDateState => ({ mode: this.dateMode, chosen: this.dateChosen });
    const syncDateDropdown = (): void => {
      dateDropdown.value = taskDateDropdownValue(currentTaskDate());
    };
    syncDateDropdown();
    /**
     * Дата ежедневной заметки следует за датой задачи (в одну сторону): назначается ниже,
     * когда созданы элементы управления «Дата ежедневной заметки».
     */
    let syncDailyHeadingFromTaskDate: () => void = () => {};
    let lastTaskDateKey = taskDateKey(currentTaskDate());
    /** Показать состояние даты задачи и, если дата действительно изменилась, подтянуть дату ежедневной. */
    const applyTaskDateChange = (): void => {
      syncDateDropdown();
      dateSummary.setText(getDateSummary());
      const key = taskDateKey(currentTaskDate());
      if (key === lastTaskDateKey) return;
      lastTaskDateKey = key;
      syncDailyHeadingFromTaskDate();
    };
    dateDropdown.addEventListener("change", () => {
      const picked = dateDropdown.value;
      if (picked === "choose") {
        // Окно даты открывается с уже выбранного дня; отмена возвращает прежнее состояние (не «сегодня»).
        const previous = currentTaskDate();
        pickDay(this.app, "Дата задачи", this.dateChosen, (value) => {
          if (value) {
            this.dateMode = "choose";
            this.dateChosen = value;
          } else {
            this.dateMode = previous.mode;
            this.dateChosen = previous.chosen;
          }
          applyTaskDateChange();
        });
      } else if (picked === "today") {
        this.dateMode = "today";
        this.dateChosen = "";
        applyTaskDateChange();
      } else {
        // Скрытый пункт «дата выбрана» (например, стрелками с клавиатуры) - состояние не меняется
        applyTaskDateChange();
      }
    });
    if (this.ctx.plugin.settings.enableGamification) {
      new Setting(form)
        .setName("Сложность задачи")
        .addDropdown((d) => {
          d.addOption("", "-");
          for (const v of DIFFICULTY_OPTIONS) d.addOption(v, v);
          d.setValue(this.difficulty).onChange((v) => (this.difficulty = v));
        });
    }
    new Setting(form)
      .setName("Статус задачи")
      .addDropdown((d) => {
        for (const { value, label } of getDropdownOptions()) {
          d.addOption(value, label);
        }
        d.setValue(this.status || "").onChange((v) => (this.status = v ?? ""));
      });
    new Setting(form)
      .setName("Группа задачи")
      .addText((t) => {
        this.groupInputRef = t;
        t.setPlaceholder("Группа задачи")
          .setValue(this.group)
          .onChange((v) => (this.group = v));
      });
    if (this.ctx.plugin.settings.enableDeadline) {
      const deadlineSetting = new Setting(form).setName("Дедлайн");
      const deadlineWrap = deadlineSetting.controlEl.createDiv({ cls: "opa-multi-select-row" });
      const deadlineSummary = deadlineWrap.createSpan({ cls: "opa-multi-select-summary" });
      const setDeadlineSummary = (): void => {
        deadlineSummary.setText(this.deadline || "Не указан");
      };
      setDeadlineSummary();
      const btn = deadlineWrap.createEl("button", { text: "Выбрать дату", cls: "mod-secondary" });
      btn.addEventListener("click", () => {
        pickDay(this.app, "Дедлайн", this.deadline, (value) => {
          if (value) {
            this.deadline = value;
            setDeadlineSummary();
          }
        });
      });
    }
    const headingSetting = new Setting(form).setName("Дата ежедневной заметки");
    const headingWrap = headingSetting.controlEl.createDiv({ cls: "opa-multi-select-row" });
    const headingSummary = headingWrap.createSpan({ cls: "opa-multi-select-summary" });
    const getHeadingSummary = (): string => {
      if (this.dailyHeadingMode === "none") return "";
      if (this.dailyHeadingMode === "today") return formatDateDDMMYYYY(new Date());
      return this.dailyHeadingDate || "Выбрать день";
    };
    headingSummary.setText(getHeadingSummary());
    const headingDropdown = headingWrap.createEl("select", { cls: "dropdown" });
    headingDropdown.createEl("option", { value: "none", text: "-" });
    headingDropdown.createEl("option", { value: "today", text: "Сегодняшний день" });
    headingDropdown.createEl("option", { value: "choose", text: "Выбрать день" });
    addChosenDayOption(headingDropdown);
    const currentDailyHeading = (): DailyHeadingState => ({ mode: this.dailyHeadingMode, date: this.dailyHeadingDate });
    /** Показать состояние даты ежедневной заметки в <select> и сводке. */
    const applyHeadingState = (): void => {
      headingDropdown.value = dailyHeadingDropdownValue(currentDailyHeading());
      headingSummary.setText(getHeadingSummary());
    };
    applyHeadingState();
    // Смена даты ежедневной заметки на дату задачи не влияет: здесь dateMode/dateChosen не трогаем.
    headingDropdown.addEventListener("change", () => {
      const picked = headingDropdown.value;
      if (picked === "choose") {
        // Окно даты открывается с уже выбранного дня; отмена возвращает прежнее состояние.
        const previous = currentDailyHeading();
        pickDay(this.app, "Дата ежедневной заметки", this.dailyHeadingDate, (value) => {
          if (value) {
            this.dailyHeadingMode = "choose";
            this.dailyHeadingDate = value;
          } else {
            this.dailyHeadingMode = previous.mode;
            this.dailyHeadingDate = previous.date;
          }
          applyHeadingState();
        });
      } else if (picked === "today" || picked === "none") {
        this.dailyHeadingMode = picked;
        this.dailyHeadingDate = "";
        applyHeadingState();
      } else {
        // Скрытый пункт «дата выбрана» - состояние не меняется
        applyHeadingState();
      }
    });
    /** Дата задачи изменилась → ежедневная заметка на тот же день (см. dailyHeadingFollowingTaskDate). */
    syncDailyHeadingFromTaskDate = () => {
      const next = dailyHeadingFollowingTaskDate(currentTaskDate(), currentDailyHeading());
      this.dailyHeadingMode = next.mode;
      this.dailyHeadingDate = next.date;
      applyHeadingState();
    };
    // Подвал (ошибка и кнопки) прижат к низу окна и остаётся на виду при прокрутке полей
    const footer = form.createDiv({ cls: "opa-create-task-footer" });
    this.errorEl = footer.createDiv({ cls: "opa-create-task-error", attr: { role: "alert" } });
    this.errorEl.hide();
    const btnRow = footer.createDiv({ cls: "opa-create-task-buttons" });
    btnRow.createEl("button", { text: "Отмена", cls: "mod-secondary" }).onclick = () => this.close();
    const createBtn = btnRow.createEl("button", { text: "Создать", cls: "mod-cta" });
    createBtn.onclick = async () => {
      if (!this.name.trim()) {
        this.errorEl?.setText("Введите название.");
        this.errorEl?.show();
        nameInput?.focus();
        return;
      }
      createBtn.disabled = true;
      this.errorEl?.hide();
      try {
        await this.onDone({
          name: this.name.trim(),
          project: this.project,
          context: this.context,
          environment: this.environment,
          date: this.dateMode === "today" ? "" : this.dateChosen,
          difficulty: this.ctx.plugin.settings.enableGamification ? this.difficulty : "",
          status: this.status,
          group: this.group,
          templateKey: this.templateKey,
          dailyHeadingMode: this.dailyHeadingMode,
          dailyHeadingDate: this.dailyHeadingDate,
          deadline: this.ctx.plugin.settings.enableDeadline ? this.deadline : undefined,
        });
        this.close();
      } catch (error) {
        console.error(error);
        this.errorEl?.setText(
          error instanceof Error ? error.message : "Не удалось создать задачу."
        );
        this.errorEl?.show();
        nameInput?.focus();
        nameInput?.select();
      } finally {
        createBtn.disabled = false;
      }
    };
    const onEnter = (evt: KeyboardEvent) => {
      if (evt.key !== "Enter" || evt.isComposing) return;
      if (!this.modalEl.isConnected) return;
      const active = document.activeElement;
      // Enter в текстовом поле (название, группа) создаёт задачу; в списках, кнопках и textarea - нет.
      if (active?.matches("textarea, select, button, input:not([type=text])")) return;
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
    // Фокус в названии: с предзаполненным названием (из блокнота или строки ежедневной) достаточно нажать Enter
    setTimeout(() => {
      if (!nameInput || !this.modalEl.isConnected) return;
      nameInput.focus();
      const end = nameInput.value.length;
      nameInput.setSelectionRange(end, end);
    }, 0);
  }
}

export class CreateProjectModal extends Modal {
  private name = "";
  private errorEl: HTMLElement | null = null;

  constructor(
    app: App,
    private onDone: (p: { name: string }) => Promise<void>
  ) {
    super(app);
    this.setTitle("Создать проект");
  }

  onOpen(): void {
    this.modalEl.addClass("opa-create-task-modal");
    const { contentEl } = this;
    const form = contentEl.createDiv({ cls: "opa-create-task-form" });
    let nameInput: HTMLInputElement | null = null;
    new Setting(form).setName("Имя проекта").addText((t) => {
      nameInput = t.inputEl;
      t.setPlaceholder("Название").onChange((v) => (this.name = v));
    });
    // Подвал (ошибка и кнопки) прижат к низу окна и остаётся на виду при прокрутке полей
    const footer = form.createDiv({ cls: "opa-create-task-footer" });
    this.errorEl = footer.createDiv({ cls: "opa-create-task-error", attr: { role: "alert" } });
    this.errorEl.hide();
    const btnRow = footer.createDiv({ cls: "opa-create-task-buttons" });
    btnRow.createEl("button", { text: "Отмена", cls: "mod-secondary" }).onclick = () => this.close();
    const createBtn = btnRow.createEl("button", { text: "Создать", cls: "mod-cta" });
    createBtn.onclick = async () => {
      if (!this.name.trim()) {
        this.errorEl?.setText("Введите имя проекта.");
        this.errorEl?.show();
        nameInput?.focus();
        return;
      }
      createBtn.disabled = true;
      this.errorEl?.hide();
      try {
        await this.onDone({ name: this.name.trim() });
        this.close();
      } catch (error) {
        console.error(error);
        this.errorEl?.setText(
          error instanceof Error ? error.message : "Не удалось создать проект."
        );
        this.errorEl?.show();
        nameInput?.focus();
        nameInput?.select();
      } finally {
        createBtn.disabled = false;
      }
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
