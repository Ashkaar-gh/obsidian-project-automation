/**
 * Окно выбора даты степперами день / месяц / год. Общее для полей формы «Создать задачу» (дата задачи,
 * дата ежедневной заметки, дедлайн), команды «Запись о задаче» и даты в блоке активностей.
 * Клавиатура: Tab - переход между степперами, стрелки - значение, Enter - OK.
 * onDone вызывается ровно один раз: выбранная дата (локальная полночь) или null - «Отмена», Esc, клик вне окна.
 */

import { Modal, type App } from "obsidian";
import { MONTH_NAMES_RU, getDaysInMonth } from "../core/DateUtils";
import { UI_LABELS } from "./Labels";

export interface DatePickerOptions {
  title: string;
  /** Начальная дата (некорректная или отсутствующая - сегодня). */
  initial?: Date | null;
  /** Позже этой даты выбрать нельзя (например, активности не отмечают в будущем); «Текущий день» ставит её. */
  max?: Date | null;
  /** Нижняя граница года у степпера. */
  yearMin?: number;
  /** Верхняя граница года; по умолчанию год max или текущий год + 10. */
  yearMax?: number;
  onDone: (date: Date | null) => void;
}

export class DatePickerModal extends Modal {
  private day: number;
  /** 1..12 */
  private month: number;
  private year: number;
  private readonly max: { year: number; month: number; day: number } | null;
  private readonly yearMin: number;
  private readonly yearMax: number;
  private finished = false;
  private dayEl!: HTMLElement;
  private monthEl!: HTMLElement;
  private yearEl!: HTMLElement;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(app: App, private readonly options: DatePickerOptions) {
    super(app);
    this.setTitle(options.title);
    const now = new Date();
    const initial = options.initial && !isNaN(options.initial.getTime()) ? options.initial : now;
    this.year = initial.getFullYear();
    this.month = initial.getMonth() + 1;
    this.day = initial.getDate();
    this.max = options.max
      ? { year: options.max.getFullYear(), month: options.max.getMonth() + 1, day: options.max.getDate() }
      : null;
    this.yearMin = options.yearMin ?? 2020;
    this.yearMax = options.yearMax ?? (this.max ? this.max.year : now.getFullYear() + 10);
  }

  private finish(date: Date | null): void {
    if (this.finished) return;
    this.finished = true;
    this.options.onDone(date);
  }

  onOpen(): void {
    this.modalEl.addClass("opa-daily-heading-date-modal");
    this.clamp();
    const { contentEl } = this;

    const steppersWrap = contentEl.createDiv({ cls: "opa-daily-heading-date-steppers-wrap" });
    const row = steppersWrap.createDiv({ cls: "gamification-completed-month-wrap opa-daily-heading-date-steppers" });
    const dayStepper = this.createStepper(row, (delta) => this.changeDay(delta), "gamification-stepper-value");
    this.dayEl = dayStepper.value;
    const monthStepper = this.createStepper(row, (delta) => this.changeMonth(delta), "gamification-stepper-value gamification-stepper-month");
    this.monthEl = monthStepper.value;
    const yearStepper = this.createStepper(row, (delta) => this.changeYear(delta), "gamification-stepper-value");
    this.yearEl = yearStepper.value;
    this.refreshLabels();

    const currentDayRow = steppersWrap.createDiv({ cls: "opa-daily-heading-current-day-row" });
    currentDayRow
      .createEl("button", { type: "button", cls: "gamification-stepper-current-btn", text: "Текущий день" })
      .addEventListener("click", () => {
        const target = this.max ?? this.todayParts();
        this.year = target.year;
        this.month = target.month;
        this.day = target.day;
        this.clamp();
        this.refreshLabels();
      });

    const steppers = [dayStepper.group, monthStepper.group, yearStepper.group];
    this.keydownHandler = (e: KeyboardEvent) => {
      const focusedIdx = steppers.indexOf(document.activeElement as HTMLElement);
      if (e.key === "Enter" && focusedIdx >= 0) {
        e.preventDefault();
        this.confirm();
        return;
      }
      if (e.key === "Tab") {
        if (focusedIdx >= 0) {
          e.preventDefault();
          const next = e.shiftKey ? (focusedIdx - 1 + 3) % 3 : (focusedIdx + 1) % 3;
          steppers[next].focus();
        }
        return;
      }
      if (focusedIdx < 0) return;
      const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
      if (delta === 0) return;
      e.preventDefault();
      if (focusedIdx === 0) this.changeDay(delta);
      else if (focusedIdx === 1) this.changeMonth(delta);
      else this.changeYear(delta);
    };
    contentEl.addEventListener("keydown", this.keydownHandler);
    setTimeout(() => dayStepper.group.focus(), 0);

    const btnRow = contentEl.createDiv({ cls: "opa-daily-heading-date-buttons" });
    btnRow.createEl("button", { text: UI_LABELS.common.cancel, cls: "mod-secondary" }).addEventListener("click", () => {
      this.finish(null);
      this.close();
    });
    btnRow.createEl("button", { text: UI_LABELS.common.ok, cls: "mod-cta" }).addEventListener("click", () => this.confirm());
  }

  onClose(): void {
    // Esc или клик вне окна - отмена: вызывающий код должен узнать об этом и вернуть прежнее состояние поля
    this.finish(null);
    if (this.keydownHandler) {
      this.contentEl.removeEventListener("keydown", this.keydownHandler);
      this.keydownHandler = null;
    }
  }

  private createStepper(
    parent: HTMLElement,
    onChange: (delta: number) => void,
    valueCls: string
  ): { group: HTMLElement; value: HTMLElement } {
    const groupWrap = parent.createDiv({ cls: "gamification-month-group" });
    const group = groupWrap.createDiv({ cls: "gamification-stepper-group" });
    group.tabIndex = 0;
    group
      .createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" })
      .addEventListener("click", () => onChange(-1));
    const value = group.createEl("span", { cls: valueCls });
    group
      .createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" })
      .addEventListener("click", () => onChange(1));
    return { group, value };
  }

  private todayParts(): { year: number; month: number; day: number } {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }

  private confirm(): void {
    this.clamp();
    this.finish(new Date(this.year, this.month - 1, this.day));
    this.close();
  }

  private refreshLabels(): void {
    this.dayEl.setText(String(this.day));
    this.monthEl.setText(MONTH_NAMES_RU[this.month - 1] ?? "");
    this.yearEl.setText(String(this.year));
  }

  /** День в пределах месяца; дата не позже max, если он задан. */
  private clamp(): void {
    const daysInMonth = getDaysInMonth(this.year, this.month);
    if (this.day > daysInMonth) this.day = daysInMonth;
    if (this.day < 1) this.day = 1;
    if (this.max && this.compareToMax() > 0) {
      this.year = this.max.year;
      this.month = this.max.month;
      this.day = this.max.day;
    }
  }

  private compareToMax(): number {
    if (!this.max) return -1;
    const current = this.year * 10000 + this.month * 100 + this.day;
    const max = this.max.year * 10000 + this.max.month * 100 + this.max.day;
    return current - max;
  }

  private changeDay(delta: number): void {
    this.day += delta;
    if (this.day < 1) {
      this.month--;
      if (this.month < 1) {
        this.month = 12;
        this.year--;
      }
      this.day = getDaysInMonth(this.year, this.month);
    } else if (this.day > getDaysInMonth(this.year, this.month)) {
      this.day = 1;
      this.month++;
      if (this.month > 12) {
        this.month = 1;
        this.year++;
      }
    }
    this.clamp();
    this.refreshLabels();
  }

  private changeMonth(delta: number): void {
    this.month += delta;
    if (this.month > 12) {
      this.month = 1;
      this.year++;
    } else if (this.month < 1) {
      this.month = 12;
      this.year--;
    }
    this.clamp();
    this.refreshLabels();
  }

  private changeYear(delta: number): void {
    this.year += delta;
    if (this.year > this.yearMax) this.year = this.yearMax;
    if (this.year < this.yearMin) this.year = this.yearMin;
    this.clamp();
    this.refreshLabels();
  }
}
