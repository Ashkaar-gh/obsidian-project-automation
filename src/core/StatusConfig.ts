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

const DEFAULT_ICON = "❓";
const DEFAULT_WEIGHT = 50;

export function getConfig(statusStr: string | null | undefined): StatusItem | undefined {
  const s = (statusStr ?? "").toLowerCase();
  return STATUS_CONFIG.find((c) => s.includes(c.key));
}

export function getIcon(statusStr: string | null | undefined): string {
  const conf = getConfig(statusStr);
  return conf ? conf.icon : DEFAULT_ICON;
}

export function getWeight(statusStr: string | null | undefined): number {
  const conf = getConfig(statusStr);
  return conf ? conf.weight : DEFAULT_WEIGHT;
}

export function getDropdownOptions(): { value: string; label: string; icon: string }[] {
  return STATUS_CONFIG.map((c) => ({
    value: c.label,
    label: `${c.label} ${c.icon}`,
    icon: c.icon,
  }));
}

export const REFRESH_DELAY_MS = 500;
export const REFRESH_DELAY_MS_FAST = 100;
