/**
 * Награда за выполнение напоминания, живущего в .md-заметке. Награду нельзя записать в заметку и в data.json
 * одной атомарной операцией, поэтому порядок такой: в выполненную строку дописывается маркер-намерение
 * `<!-- opa-reminder-reward:id:xp:gold[:streakKey:onTime] -->`, затем награда начисляется в data.json
 * (id запоминается, чтобы не начислить дважды), затем маркер убирается из заметки. Если плагин прервётся
 * между шагами, маркер в файле позволяет доначислить награду при следующем запуске.
 * Чистые функции без Obsidian.
 */

import type { GamificationState } from "./GamificationState";

/** Начало маркера: дешёвая проверка «есть ли в тексте незавершённые награды». */
export const REMINDER_REWARD_MARKER_PREFIX = "<!-- opa-reminder-reward:";

const REWARD_NUMBER_PATTERN = "\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?";

/** Глобальный regex: использовать только с matchAll/replace (у test/exec с флагом g есть состояние). */
export const REMINDER_REWARD_MARKER_REGEX = new RegExp(
  `\\s*<!-- opa-reminder-reward:([A-Za-z0-9_-]+):(${REWARD_NUMBER_PATTERN}):(${REWARD_NUMBER_PATTERN})(?::([^:>]+):([01]))? -->`,
  "gi"
);

export interface ReminderRewardIntent {
  id: string;
  xp: number;
  gold: number;
  /** Ключ стрика (текст повторяющегося напоминания); нет - напоминание не повторяющееся. */
  streakKey?: string;
  /** Выполнено в срок: стрик растёт, иначе начинается заново с 1. */
  streakOnTime?: boolean;
}

export function createReminderRewardIntent(
  xp: number,
  gold: number,
  streak?: { key: string; onTime: boolean }
): ReminderRewardIntent {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    xp,
    gold,
    streakKey: streak?.key,
    streakOnTime: streak?.onTime,
  };
}

export function rewardMarker(intent: ReminderRewardIntent): string {
  const streak = intent.streakKey == null
    ? ""
    : `:${encodeURIComponent(intent.streakKey)}:${intent.streakOnTime ? "1" : "0"}`;
  return `<!-- opa-reminder-reward:${intent.id}:${intent.xp}:${intent.gold}${streak} -->`;
}

/** Все маркеры-намерения в тексте (в порядке появления). */
export function rewardIntentsFromText(text: string): ReminderRewardIntent[] {
  if (!text.includes(REMINDER_REWARD_MARKER_PREFIX)) return [];
  return [...text.matchAll(REMINDER_REWARD_MARKER_REGEX)].map((match) => {
    let streakKey: string | undefined;
    if (match[4]) {
      try {
        streakKey = decodeURIComponent(match[4]);
      } catch {
        streakKey = undefined;
      }
    }
    return {
      id: match[1],
      xp: Number(match[2]),
      gold: Number(match[3]),
      streakKey,
      streakOnTime: streakKey == null ? undefined : match[5] === "1",
    };
  });
}

/** Текст без всех маркеров-намерений. */
export function stripRewardMarkers(text: string): string {
  return text.includes(REMINDER_REWARD_MARKER_PREFIX) ? text.replace(REMINDER_REWARD_MARKER_REGEX, "") : text;
}

/** Текст без маркера конкретного намерения (вместе с пробелом перед ним). */
export function removeRewardMarker(text: string, intent: ReminderRewardIntent): string {
  const marker = rewardMarker(intent);
  return text.split(` ${marker}`).join("").split(marker).join("");
}

/** Начислить награду и обновить стрик в состоянии геймификации (мутирует state). */
export function applyReminderRewardIntent(state: GamificationState, intent: ReminderRewardIntent): void {
  state.xp += intent.xp;
  state.gold += intent.gold;
  if (intent.streakKey != null) {
    state.streaks[intent.streakKey] = intent.streakOnTime
      ? (state.streaks[intent.streakKey] ?? 0) + 1
      : 1;
  }
}
