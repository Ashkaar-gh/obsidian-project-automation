import assert from "node:assert/strict";
import test from "node:test";
import { TFile, createMockApp } from "obsidian";
import { EventBus } from "../src/core/EventBus";
import { TaskIndex, normalizeTaskKey } from "../src/core/TaskIndex";
import { RemindersIndex } from "../src/core/RemindersIndex";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("TaskIndex normalizes task names and builds daily heading history", () => {
  assert.equal(normalizeTaskKey(" Folder/My   Task.md#Part "), "my task");
  const mock = createMockApp();
  const daily = mock.addFile("periodic/daily/2026-07-27.md", "# Task A\n# Task A");
  mock.caches.set(daily.path, {
    headings: [
      { heading: "Task A", position: { start: { offset: 0 }, end: { offset: 7 } } },
      { heading: "Task A", position: { start: { offset: 9 }, end: { offset: 16 } } },
    ],
  });
  const index = new TaskIndex(mock.app, new EventBus());
  index.buildFull();
  const dates = index.getDatesForTask("Task A");
  assert.equal(dates.length, 1);
  assert.equal(dates[0].getFullYear(), 2026);
  assert.equal(dates[0].getMonth(), 6);
  assert.equal(dates[0].getDate(), 27);
});

test("TaskIndex ignores files in the daily folder whose name is not a date", () => {
  const mock = createMockApp();
  const readme = mock.addFile("periodic/daily/README.md", "# Task A");
  mock.caches.set(readme.path, {
    headings: [{ heading: "Task A", position: { start: { offset: 0 }, end: { offset: 8 } } }],
  });
  const index = new TaskIndex(mock.app, new EventBus());
  index.buildFull();
  // Раньше дата такого файла бралась из времени изменения и попадала в «Срок» задачи на доске
  assert.equal(index.getDatesForTask("Task A").length, 0);
});

test("TaskIndex rebuilds once after the first metadata resolve, not after every edit", () => {
  const mock = createMockApp();
  const index = new TaskIndex(mock.app, new EventBus());
  index.ensureSubscribed();
  assert.equal(mock.metadataCache.listenerCount("resolved"), 1);
  mock.metadataCache.emit("resolved");
  assert.equal(mock.metadataCache.listenerCount("resolved"), 0);
  index.unsubscribe();
});

test("TaskIndex resolves wikilinks by both basename and exact path", () => {
  const mock = createMockApp();
  const daily = mock.addFile("periodic/daily/27-07-2026.md", "# [[Tasks/Alpha|A]]");
  const task = mock.addFile("Tasks/Alpha.md");
  mock.destinations.set("Tasks/Alpha", task);
  mock.caches.set(daily.path, {
    headings: [{ heading: "[[Tasks/Alpha|A]]", position: { start: { offset: 0 }, end: { offset: 20 } } }],
    links: [{ link: "Tasks/Alpha", position: { start: { offset: 2 } } }],
  });
  const index = new TaskIndex(mock.app, new EventBus());
  index.buildFull();
  assert.equal(index.getDatesForTask("Alpha").length, 1);
  assert.equal(index.getDatesForTask("wrong", "Tasks/Alpha.md").length, 1);
});

test("TaskIndex replaces changed contributions and removes all subscriptions", async () => {
  const mock = createMockApp();
  const daily = mock.addFile("periodic/daily/2026-07-27.md", "# Before");
  mock.caches.set(daily.path, {
    headings: [{ heading: "Before", position: { start: { offset: 0 }, end: { offset: 8 } } }],
  });
  const index = new TaskIndex(mock.app, new EventBus());
  index.ensureSubscribed();
  mock.caches.set(daily.path, {
    headings: [{ heading: "After", position: { start: { offset: 0 }, end: { offset: 7 } } }],
  });
  mock.metadataCache.emit("changed", daily);
  assert.equal(index.getDatesForTask("Before").length, 0);
  assert.equal(index.getDatesForTask("After").length, 1);
  index.unsubscribe();
  assert.equal(mock.vault.listenerCount("create"), 0);
  assert.equal(mock.vault.listenerCount("delete"), 0);
  assert.equal(mock.vault.listenerCount("rename"), 0);
  await flush();
});

test("RemindersIndex merges data.json and markdown while excluding templates and trash", async () => {
  const mock = createMockApp({
    "Notes.md": "- [ ] Future (@01-01-2099 10:00)\n- [x] Done (@01-01-2000 10:00)",
    "templates/task.md": "- [ ] Hidden (@01-01-2099 10:00)",
    "Trash.md": "- [ ] Trashed (@01-01-2099 10:00)",
  });
  const plugin = {
    async loadData() { return { reminders: ["- [ ] Data (@02-01-2099 10:00)"] }; },
    getGamificationDataPath() { return ".obsidian/plugins/opa/data.json"; },
  };
  const index = new RemindersIndex(mock.app, plugin);
  await index.buildFull();
  const data = index.getReminderData();
  assert.equal(data.upcoming.length, 2);
  assert.equal(data.completed.length, 1);
  assert.deepEqual(data.upcoming.map((item) => item.text), ["Future", "Data"]);
});

test("RemindersIndex known content bypasses vault read and replaces old entries", async () => {
  const mock = createMockApp({ "Notes.md": "old" });
  const file = mock.files.get("Notes.md") as TFile;
  let reads = 0;
  mock.vault.read = async () => { reads++; return "old"; };
  const index = new RemindersIndex(mock.app, {
    async loadData() { return {}; },
    getGamificationDataPath() { return "data.json"; },
  });
  await index.updateFile(file, "- [ ] First (@01-01-2099)");
  await index.updateFile(file, "- [ ] Second (@02-01-2099)");
  assert.equal(reads, 0);
  assert.deepEqual(index.getReminderData().upcoming.map((item) => item.text), ["Second"]);
});

test("RemindersIndex tracks files with pending reward markers and forgets them once cleaned", async () => {
  const marker = "<!-- opa-reminder-reward:abc:2:1 -->";
  const mock = createMockApp({
    "Notes.md": `- [x] Done (@01-01-2000 10:00) ${marker}`,
    "Other.md": "- [ ] Future (@01-01-2099 10:00)",
  });
  const index = new RemindersIndex(mock.app, {
    async loadData() { return {}; },
    getGamificationDataPath() { return "data.json"; },
  });
  await index.buildFull();
  assert.deepEqual(index.getFilesWithRewardMarkers(), ["Notes.md"]);
  await index.updateFile(mock.files.get("Notes.md") as TFile, "- [x] Done (@01-01-2000 10:00)");
  assert.deepEqual(index.getFilesWithRewardMarkers(), []);
});

test("RemindersIndex defers only the create subscription until the layout is ready", () => {
  const mock = createMockApp();
  mock.workspace.layoutReady = false;
  const index = new RemindersIndex(mock.app, {
    async loadData() { return {}; },
    getGamificationDataPath() { return "data.json"; },
  });
  index.ensureSubscribed();
  // На старте vault эмитит create для каждого файла - все они уже входят в buildFull;
  // rename/modify/delete нужны сразу, иначе переименованный до готовности layout файл остался бы под старым путём
  assert.equal(mock.vault.listenerCount("modify"), 1);
  assert.equal(mock.vault.listenerCount("delete"), 1);
  assert.equal(mock.vault.listenerCount("rename"), 1);
  assert.equal(mock.vault.listenerCount("create"), 0);
  mock.workspace.markLayoutReady();
  assert.equal(mock.vault.listenerCount("create"), 1);
  index.unsubscribe();
  assert.equal(mock.vault.listenerCount("create"), 0);
  assert.equal(mock.vault.listenerCount("rename"), 0);
});

test("RemindersIndex skips reading files whose metadata cache proves there are no task lines", async () => {
  const mock = createMockApp({
    "Tasks.md": "- [ ] Future (@01-01-2099 10:00)",
    "Plain.md": "просто текст",
    "Checked.md": "- [x] Done (@01-01-2000 10:00)",
    "Quoted.md": "> [!todo]\n> - [ ] Quoted (@02-01-2099 10:00)",
  });
  mock.caches.set("Plain.md", { listItems: [], sections: [{ type: "paragraph" }] });
  mock.caches.set("Checked.md", { listItems: [{ task: "x" }], sections: [{ type: "list" }] });
  // Чекбокс внутри callout в listItems не попадает, но и напоминанием не считается (строка начинается с «>»)
  mock.caches.set("Quoted.md", { sections: [{ type: "callout" }] });
  const readPaths: string[] = [];
  mock.vault.cachedRead = async (file: TFile) => {
    readPaths.push(file.path);
    return mock.contents.get(file.path) ?? "";
  };
  const index = new RemindersIndex(mock.app, {
    async loadData() { return {}; },
    getGamificationDataPath() { return "data.json"; },
  });
  await index.buildFull();
  // Без кэша файл читается на всякий случай; с кэшем без задач - пропускается
  assert.deepEqual(readPaths.sort(), ["Checked.md", "Tasks.md"]);
  assert.deepEqual(index.getReminderData().upcoming.map((item) => item.text), ["Future"]);
  assert.equal(index.getReminderData().completed.length, 1);
  // Тот же результат, что и при чтении файла в цитате: строка в callout напоминанием не становится
  await index.updateFile(mock.files.get("Quoted.md") as TFile);
  assert.deepEqual(index.getReminderData().upcoming.map((item) => item.text), ["Future"]);
});

test("RemindersIndex built on a ready cache rebuilds once more after the first metadata resolve", async () => {
  const mock = createMockApp({ "First.md": "- [ ] First (@01-01-2099 10:00)" });
  const index = new RemindersIndex(mock.app, {
    async loadData() { return {}; },
    getGamificationDataPath() { return "data.json"; },
  });
  index.ensureSubscribed();
  await index.waitReady();
  assert.deepEqual(index.getReminderData().upcoming.map((item) => item.text), ["First"]);
  assert.equal(mock.metadataCache.listenerCount("resolved"), 1);

  // Файл, доиндексированный Obsidian после старта (изменён, пока приложение было закрыто)
  mock.addFile("Second.md", "- [ ] Second (@02-01-2099 10:00)");
  mock.metadataCache.emit("resolved");
  await flush();
  await flush();
  assert.deepEqual(index.getReminderData().upcoming.map((item) => item.text), ["First", "Second"]);
  assert.equal(mock.metadataCache.listenerCount("resolved"), 0, "пересборка по resolved одноразовая");
  index.unsubscribe();
});

test("RemindersIndex unsubscribes before metadata readiness without hanging", async () => {
  const mock = createMockApp();
  mock.metadataCache.initialized = false;
  const index = new RemindersIndex(mock.app, {
    async loadData() { return {}; },
    getGamificationDataPath() { return "data.json"; },
  });
  index.ensureSubscribed();
  const ready = index.waitReady();
  index.unsubscribe();
  await ready;
  assert.equal(mock.vault.listenerCount("modify"), 0);
});

test("RemindersIndex discards stale file reads that finish out of order", async () => {
  const mock = createMockApp({ "Notes.md": "" });
  const file = mock.files.get("Notes.md") as TFile;
  let resolveOld!: (content: string) => void;
  let resolveNew!: (content: string) => void;
  const oldRead = new Promise<string>((resolve) => { resolveOld = resolve; });
  const newRead = new Promise<string>((resolve) => { resolveNew = resolve; });
  let reads = 0;
  mock.vault.read = () => reads++ === 0 ? oldRead : newRead;
  const index = new RemindersIndex(mock.app, {
    async loadData() { return {}; },
    getGamificationDataPath() { return "data.json"; },
  });

  const first = index.updateFile(file);
  const second = index.updateFile(file);
  resolveNew("- [ ] New (@02-01-2099)");
  await second;
  resolveOld("- [ ] Old (@01-01-2099)");
  await first;

  assert.deepEqual(index.getReminderData().upcoming.map((item) => item.text), ["New"]);
});
