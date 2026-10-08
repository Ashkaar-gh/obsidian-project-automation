/** Конфигурация статусов задач: ключ, метка, иконка, вес для сортировки. */

export interface StatusItem {
  key: string;
  label: string;
  icon: string;
  weight: number;
}

export const STATUS_CONFIG: StatusItem[] = [
  { key: "в работе", label: "В работе", icon: "⚙️", weight: 10 },
  { key: "тестирование", label: "Тестирование", icon: "🔍", weight: 20 },
  { key: "повторяющиеся", label: "Повторяющиеся", icon: "🔁", weight: 30 },
  { key: "backlog", label: "Backlog", icon: "🗒️", weight: 40 },
  { key: "готово", label: "Готово", icon: "☑️", weight: 90 },
  { key: "отменено", label: "Отменено", icon: "🚫", weight: 100 },
];

/** Пустой / не заданный статус (не путать с неизвестным значением). */
export const EMPTY_STATUS_ICON = "◽";

const UNKNOWN_STATUS_ICON = "❓";
const DEFAULT_WEIGHT = 50;

export function isEmptyStatus(statusStr: string | null | undefined): boolean {
  return (statusStr ?? "").trim() === "";
}

export function getConfig(statusStr: string | null | undefined): StatusItem | undefined {
  const s = (statusStr ?? "").toLowerCase().trim();
  return STATUS_CONFIG.find((c) => s === c.key);
}

export function getIcon(statusStr: string | null | undefined): string {
  if (isEmptyStatus(statusStr)) return EMPTY_STATUS_ICON;
  const conf = getConfig(statusStr);
  return conf ? conf.icon : UNKNOWN_STATUS_ICON;
}

export function getWeight(statusStr: string | null | undefined): number {
  if (isEmptyStatus(statusStr)) return DEFAULT_WEIGHT;
  const conf = getConfig(statusStr);
  return conf ? conf.weight : DEFAULT_WEIGHT;
}

export function getDropdownOptions(): { value: string; label: string; icon: string }[] {
  return [
    { value: "", label: `Без статуса ${EMPTY_STATUS_ICON}`, icon: EMPTY_STATUS_ICON },
    ...STATUS_CONFIG.map((c) => ({
      value: c.label,
      label: `${c.label} ${c.icon}`,
      icon: c.icon,
    })),
  ];
}
