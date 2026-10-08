import assert from "node:assert/strict";
import test from "node:test";
import {
  getLevel,
  getRewardForDifficulty,
  getXpInCurrentLevel,
  getXpPerLevel,
  normalizeDifficultyKey,
  normalizeGamificationState,
  readDataFile,
  updateDataFile,
  writeDataFile,
} from "../src/core/GamificationState";

class MemoryStorage {
  data: any;
  saves = 0;

  constructor(data: any = {}) {
    this.data = structuredClone(data);
  }

  async loadData() { return structuredClone(this.data); }
  async saveData(data: unknown) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.data = structuredClone(data);
    this.saves++;
  }
}

test("gamification normalizes corrupt state and deduplicates processed tasks", () => {
  const state = normalizeGamificationState({
    xp: -1,
    gold: Infinity,
    processedTasks: [
      { path: "a.md", completedAt: "old" },
      { path: "a.md", completedAt: "new" },
      { nope: true },
    ],
    processedTaskPaths: ["a.md", "b.md", "b.md"],
    streaks: { valid: 2, bad: -1 },
    shop: [{ name: "Tea", cost: 3 }, { name: "", cost: 1 }],
  });

  assert.equal(state.xp, 0);
  assert.equal(state.gold, 0);
  assert.deepEqual(state.processedTaskPaths, ["a.md", "b.md"]);
  assert.equal(state.processedTasks[0].completedAt, "new");
  assert.deepEqual(state.streaks, { valid: 2 });
  assert.deepEqual(state.shop, [{ name: "Tea", cost: 3 }]);
});

test("shop stays undefined until it was saved once, and an emptied shop stays empty", () => {
  // Нет ключа - магазин ни разу не сохранялся: модуль заполнит его товарами из defaults.json
  assert.equal(normalizeGamificationState({ xp: 1 }).shop, undefined);
  assert.equal(normalizeGamificationState(undefined).shop, undefined);
  // Пользователь удалил все товары - пустой список сохраняется, заново не заполняется
  assert.deepEqual(normalizeGamificationState({ xp: 1, shop: [] }).shop, []);
});

test("gamification level math and reward fallback work at boundaries", () => {
  assert.equal(getLevel(19, 20), 1);
  assert.equal(getLevel(20, 20), 2);
  assert.equal(getXpInCurrentLevel(25, 20), 5);
  assert.equal(getXpPerLevel(25, 20), 60);
  assert.deepEqual(getRewardForDifficulty(" СРЕДНЯЯ "), { xp: 10, gold: 5 });
  assert.deepEqual(getRewardForDifficulty("unknown"), { xp: 5, gold: 2 });
});

test("reward lookup accepts the spelling written by the create-task form", () => {
  // Форма пишет «Легко / Средне / Сложно», таблица наград - «легкая / средняя / сложная»
  assert.deepEqual(getRewardForDifficulty("Легко"), { xp: 5, gold: 2 });
  assert.deepEqual(getRewardForDifficulty("Средне"), { xp: 10, gold: 5 });
  assert.deepEqual(getRewardForDifficulty("Сложно"), { xp: 20, gold: 10 });
  assert.deepEqual(getRewardForDifficulty("Тяжёлая"), { xp: 20, gold: 10 });
  assert.equal(normalizeDifficultyKey(" Сложно "), "сложная");
  assert.equal(normalizeDifficultyKey("epic"), "epic");

  // Свой ключ из настроек имеет приоритет над синонимами, а сложность по умолчанию из настроек - над встроенной
  const config = {
    difficultyRewards: { легкая: { xp: 1, gold: 1 }, сложно: { xp: 99, gold: 99 }, epic: { xp: 50, gold: 25 } },
    defaultDifficulty: "epic",
  };
  assert.deepEqual(getRewardForDifficulty("Сложно", config), { xp: 99, gold: 99 });
  assert.deepEqual(getRewardForDifficulty("Легко", config), { xp: 1, gold: 1 });
  assert.deepEqual(getRewardForDifficulty("", config), { xp: 50, gold: 25 });
  assert.deepEqual(getRewardForDifficulty(null, config), { xp: 50, gold: 25 });
});

test("data reader validates inbox, reminders, archive and activity history", async () => {
  const storage = new MemoryStorage({
    reminders: ["valid", 2],
    inbox: ["note", null],
    inboxArchive: [{ text: "done", completedAt: "2026-01-01" }, { text: 1 }],
    activities: {
      items: [{ id: "a_1", name: "Run", difficulty: "средняя" }, { id: 2, name: "bad" }],
      history: { a_1: ["2026-01-01", "2026-01-01", "invalid"] },
    },
  });
  const data = await readDataFile(storage);
  assert.deepEqual(data.reminders, ["valid"]);
  assert.deepEqual(data.inbox, ["note"]);
  assert.equal(data.inboxArchive?.length, 1);
  assert.deepEqual(data.activities?.history.a_1, { "2026-01-01": 2 });
});

test("queued data mutations preserve every concurrent update", async () => {
  const storage = new MemoryStorage({ gamification: { xp: 0 }, inbox: [], custom: "keep" });
  await Promise.all(Array.from({ length: 20 }, () => updateDataFile(storage, (data) => {
    const gamification = normalizeGamificationState(data.gamification);
    gamification.xp += 1;
    return { gamification };
  })));
  assert.equal(storage.data.gamification.xp, 20);
  assert.equal(storage.data.custom, "keep");
});

test("write queue continues after a rejected mutation", async () => {
  const storage = new MemoryStorage({ inbox: [] });
  const failed = updateDataFile(storage, () => { throw new Error("bad mutation"); });
  const successful = writeDataFile(storage, { inbox: ["saved"] });
  await assert.rejects(failed, /bad mutation/);
  await successful;
  assert.deepEqual(storage.data.inbox, ["saved"]);
});
