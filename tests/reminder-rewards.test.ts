import assert from "node:assert/strict";
import test from "node:test";
import { emptyGamificationState } from "../src/core/GamificationState";
import {
  applyReminderRewardIntent,
  createReminderRewardIntent,
  removeRewardMarker,
  rewardIntentsFromText,
  rewardMarker,
  stripRewardMarkers,
} from "../src/core/ReminderRewards";

test("reward marker round-trips through the note text, including a streak key with special characters", () => {
  const plain = createReminderRewardIntent(2, 1);
  const streak = createReminderRewardIntent(5, 2.5, { key: "Отчёт: неделя/2", onTime: true });
  const late = createReminderRewardIntent(5, 2, { key: "Полив", onTime: false });
  const line = `- [x] Отчёт (@01-07-2026 10:00) ${rewardMarker(plain)}\n- [x] Полив ${rewardMarker(streak)} ${rewardMarker(late)}\nтекст без маркеров`;

  const parsed = rewardIntentsFromText(line);
  assert.deepEqual(parsed, [plain, streak, late]);
  assert.deepEqual(rewardIntentsFromText("- [x] без маркера"), []);
  assert.equal(stripRewardMarkers(line), "- [x] Отчёт (@01-07-2026 10:00)\n- [x] Полив\nтекст без маркеров");
  // Убирается только указанный маркер (вместе с пробелом перед ним)
  assert.equal(
    removeRewardMarker(line, streak),
    `- [x] Отчёт (@01-07-2026 10:00) ${rewardMarker(plain)}\n- [x] Полив ${rewardMarker(late)}\nтекст без маркеров`
  );
});

test("applying an intent adds xp/gold and grows or resets the streak", () => {
  const state = emptyGamificationState();
  applyReminderRewardIntent(state, createReminderRewardIntent(2, 1));
  assert.equal(state.xp, 2);
  assert.equal(state.gold, 1);
  assert.deepEqual(state.streaks, {});

  applyReminderRewardIntent(state, createReminderRewardIntent(2, 1, { key: "Полив", onTime: true }));
  applyReminderRewardIntent(state, createReminderRewardIntent(2, 1, { key: "Полив", onTime: true }));
  assert.equal(state.streaks["Полив"], 2);
  applyReminderRewardIntent(state, createReminderRewardIntent(2, 1, { key: "Полив", onTime: false }));
  assert.equal(state.streaks["Полив"], 1);
  assert.equal(state.xp, 8);
  // Магазин у нового состояния не задан: он заполнится товарами из defaults.json один раз
  assert.equal(state.shop, undefined);
});
