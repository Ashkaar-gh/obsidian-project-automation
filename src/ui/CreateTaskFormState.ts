/**
 * Чистая логика формы «Создать задачу» (без DOM): связь даты задачи с датой ежедневной заметки
 * и фильтр списка мультивыбора. Вынесена отдельно, чтобы покрыть тестами.
 */

export type TaskDateMode = "today" | "choose";
export type DailyHeadingMode = "today" | "choose" | "none";

export interface TaskDateState {
  mode: TaskDateMode;
  /** Выбранная дата (DD-MM-YYYY) при mode="choose"; иначе пустая строка. */
  chosen: string;
}

export interface DailyHeadingState {
  mode: DailyHeadingMode;
  /** Выбранная дата (DD-MM-YYYY) при mode="choose"; иначе пустая строка. */
  date: string;
}

/**
 * Состояние «Дата ежедневной заметки» после смены даты задачи: тот же день, что у задачи
 * («Сегодняшний день» или выбранная дата). Связь односторонняя: смена даты ежедневной заметки
 * дату задачи не трогает (вызывающий код эту функцию тогда просто не вызывает).
 * Явное «-» (none) не переопределяется: это отказ от записи в ежедневную, а не дата.
 */
export function dailyHeadingFollowingTaskDate(task: TaskDateState, daily: DailyHeadingState): DailyHeadingState {
  if (daily.mode === "none") return daily;
  if (task.mode === "choose" && task.chosen) return { mode: "choose", date: task.chosen };
  return { mode: "today", date: "" };
}

/** Ключ состояния даты задачи: одинаковый ключ до и после - дата фактически не менялась. */
export function taskDateKey(task: TaskDateState): string {
  return task.mode === "today" ? "today" : `choose:${task.chosen}`;
}

/**
 * Значение скрытого пункта <select> «дата уже выбрана». Нативный <select> не сообщает о выборе уже
 * выбранного пункта, поэтому после выбора даты в <select> выбирается этот скрытый пункт, а «Выбрать день»
 * остаётся обычным пунктом: его повторный выбор снова даёт change и открывает окно даты.
 */
export const CHOSEN_DAY_OPTION = "chosen";

/** Значение <select> «Дата задачи» для текущего состояния. */
export function taskDateDropdownValue(task: TaskDateState): string {
  if (task.mode === "choose" && task.chosen) return CHOSEN_DAY_OPTION;
  return task.mode;
}

/** Значение <select> «Дата ежедневной заметки» для текущего состояния. */
export function dailyHeadingDropdownValue(daily: DailyHeadingState): string {
  if (daily.mode === "choose" && daily.date) return CHOSEN_DAY_OPTION;
  return daily.mode;
}

/**
 * Виден ли пункт мультивыбора при строке поиска: совпадение по подстроке без учёта регистра.
 * Отмеченные пункты видны всегда - выбранное не пропадает из виду, и отметку можно снять, не очищая поиск.
 */
export function isMultiSelectOptionVisible(value: string, checked: boolean, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q || checked) return true;
  return value.toLowerCase().includes(q);
}
