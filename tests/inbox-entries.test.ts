import assert from "node:assert/strict";
import test from "node:test";
import {
  addInboxEntry,
  addToTrash,
  editInboxEntry,
  formatInboxTime,
  imageExtensionForMime,
  inboxEntryAsOneLine,
  normalizeInboxLink,
  normalizeInboxText,
  pastedImageFileName,
  pruneInboxCreatedAt,
  pruneInboxLinks,
  pruneTrashMeta,
  removeInboxEntry,
  renameInboxLinkTask,
  splitInboxEntry,
  type InboxStore,
} from "../src/core/InboxEntries";
import { appendBlockToTaskDescriptionContent } from "../src/core/TaskDescriptionUtils";
import { getTrashEntryMarkdown, isReminderTrashEntry, readDataFile } from "../src/core/GamificationState";

const T1 = "2026-09-28T10:00:00.000Z";
const T2 = "2026-09-28T11:00:00.000Z";

test("inbox text: Windows line breaks and blank edges are normalized, inner lines kept", () => {
  assert.equal(normalizeInboxText("  \r\nSELECT *\r\nFROM acl\r\n\r\n"), "SELECT *\nFROM acl");
  assert.equal(normalizeInboxText("   "), "");
});

test("inbox text: a multi-line snippet keeps the first line's indent, a one-liner is trimmed", () => {
  assert.equal(normalizeInboxText("\n    def f():\n        pass\n"), "    def f():\n        pass");
  assert.equal(normalizeInboxText("   позвонить  "), "позвонить");
});

test("add: multi-line entry is stored as is, with creation time", () => {
  const store: InboxStore = { inbox: ["old"] };
  assert.equal(addInboxEntry(store, "SELECT *\r\nFROM acl\n", T1), "added");
  assert.deepEqual(store.inbox, ["old", "SELECT *\nFROM acl"]);
  assert.deepEqual(store.inboxCreatedAt, { "SELECT *\nFROM acl": T1 });
});

test("add: a repeat is not added twice and keeps the first time; empty text is ignored", () => {
  const store: InboxStore = {};
  addInboxEntry(store, "позвонить", T1);
  assert.equal(addInboxEntry(store, "  позвонить  ", T2), "exists");
  assert.equal(addInboxEntry(store, " \n ", T2), "empty");
  assert.deepEqual(store.inbox, ["позвонить"]);
  assert.deepEqual(store.inboxCreatedAt, { позвонить: T1 });
});

test("add: times of entries removed by an older plugin version are dropped", () => {
  const store: InboxStore = { inbox: ["a"], inboxCreatedAt: { a: T1, gone: T1 } };
  addInboxEntry(store, "b", T2);
  assert.deepEqual(store.inboxCreatedAt, { a: T1, b: T2 });
  assert.deepEqual(pruneInboxCreatedAt({ a: T1, b: 1 as unknown as string }, ["a", "b"]), { a: T1 });
});

test("edit: new text keeps its place and the original creation time", () => {
  const store: InboxStore = { inbox: ["a", "b", "c"], inboxCreatedAt: { b: T1 } };
  assert.equal(editInboxEntry(store, "b", "b\nподробности"), "updated");
  assert.deepEqual(store.inbox, ["a", "b\nподробности", "c"]);
  assert.deepEqual(store.inboxCreatedAt, { "b\nподробности": T1 });
});

test("edit: unchanged, empty, missing and duplicate texts are reported and change nothing", () => {
  const store: InboxStore = { inbox: ["a", "b"], inboxCreatedAt: { a: T1 } };
  assert.equal(editInboxEntry(store, "a", " a "), "unchanged");
  assert.equal(editInboxEntry(store, "a", "   "), "empty");
  assert.equal(editInboxEntry(store, "zzz", "new"), "missing");
  assert.equal(editInboxEntry(store, "a", "b"), "exists");
  assert.deepEqual(store.inbox, ["a", "b"]);
  assert.deepEqual(store.inboxCreatedAt, { a: T1 });
});

test("remove: returns the creation time for the archive and forgets it", () => {
  const store: InboxStore = { inbox: ["a", "b"], inboxCreatedAt: { a: T1, b: T2 } };
  assert.deepEqual(removeInboxEntry(store, "a"), { removed: true, createdAt: T1 });
  assert.deepEqual(store.inbox, ["b"]);
  assert.deepEqual(store.inboxCreatedAt, { b: T2 });
  assert.deepEqual(removeInboxEntry(store, "a"), { removed: false });
  const legacy: InboxStore = { inbox: ["old"] };
  assert.deepEqual(removeInboxEntry(legacy, "old"), { removed: true });
});

test("split: the first line is the task title, the rest goes to the description", () => {
  assert.deepEqual(splitInboxEntry("Разобраться с ACL"), { title: "Разобраться с ACL", rest: "" });
  assert.deepEqual(splitInboxEntry("\n\nРазобраться с ACL\nтикет ABC-1\n\nпозвонить Y"), {
    title: "Разобраться с ACL",
    rest: "тикет ABC-1\n\nпозвонить Y",
  });
});

test("split: a screenshot line is not a title; the picture stays in the description", () => {
  assert.deepEqual(splitInboxEntry("![[Pasted image 1.png]]\nОшибка в логах"), {
    title: "Ошибка в логах",
    rest: "![[Pasted image 1.png]]",
  });
  assert.deepEqual(splitInboxEntry("![[a.png]] Ошибка ![b](b.png) в логах\nстек"), {
    title: "Ошибка в логах",
    rest: "![[a.png]] ![b](b.png)\nстек",
  });
  assert.deepEqual(splitInboxEntry("![[only.png]]"), { title: "", rest: "![[only.png]]" });
});

test("split: code blocks are not titles; a code-only entry keeps all its text for the description", () => {
  assert.deepEqual(splitInboxEntry("```sql\nSELECT 1\n```\nЗапустить на проде"), {
    title: "Запустить на проде",
    rest: "```sql\nSELECT 1\n```",
  });
  assert.deepEqual(splitInboxEntry("```sql\nSELECT 1\nFROM t\n```"), {
    title: "SELECT 1",
    rest: "```sql\nSELECT 1\nFROM t\n```",
  });
  assert.deepEqual(splitInboxEntry("~~~\n```\ncode\n```\n~~~\nтекст"), { title: "текст", rest: "~~~\n```\ncode\n```\n~~~" });
});

test("one line: a multi-line entry becomes a single reminder line", () => {
  assert.equal(inboxEntryAsOneLine("Позвонить Y\n  по поводу\n\nдоступа  "), "Позвонить Y по поводу доступа");
});

test("time label: today, yesterday, this year and older", () => {
  const now = new Date(2026, 8, 28, 15, 0);
  const iso = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).toISOString();
  assert.equal(formatInboxTime(iso(2026, 9, 28, 9, 5), now), "сегодня 09:05");
  assert.equal(formatInboxTime(iso(2026, 9, 27, 23, 59), now), "вчера 23:59");
  assert.equal(formatInboxTime(iso(2026, 1, 3, 7, 30), now), "03.01 07:30");
  assert.equal(formatInboxTime(iso(2025, 12, 31, 18, 0), now), "31.12.2025 18:00");
  assert.equal(formatInboxTime(undefined, now), "");
  assert.equal(formatInboxTime("not a date", now), "");
});

test("time label: yesterday across a month boundary", () => {
  const now = new Date(2026, 9, 1, 8, 0);
  assert.equal(formatInboxTime(new Date(2026, 8, 30, 22, 15).toISOString(), now), "вчера 22:15");
});

test("pasted images: extension by type and Obsidian-like file name", () => {
  assert.equal(imageExtensionForMime("image/png"), "png");
  assert.equal(imageExtensionForMime("IMAGE/JPEG"), "jpg");
  assert.equal(imageExtensionForMime("text/plain"), null);
  assert.equal(pastedImageFileName(new Date(2026, 8, 28, 14, 5, 9), "png"), "Pasted image 20260928140509.png");
});

test("task description: block is appended after existing text, next section stays separated", () => {
  const note = "---\nstatus: В работе\n---\n## Описание задачи\n- был комментарий\n\n## Критерий выполнения\n- готово\n";
  assert.equal(
    appendBlockToTaskDescriptionContent(note, "тикет ABC-1\nпозвонить Y"),
    "---\nstatus: В работе\n---\n## Описание задачи\n- был комментарий\n\nтикет ABC-1\nпозвонить Y\n\n## Критерий выполнения\n- готово\n"
  );
});

test("task description: empty template section gets the block right under the heading", () => {
  const note = "---\na: 1\n---\n## Описание задачи\n\n## Критерий выполнения\n";
  assert.equal(
    appendBlockToTaskDescriptionContent(note, "текст"),
    "---\na: 1\n---\n## Описание задачи\nтекст\n\n## Критерий выполнения\n"
  );
});

test("task description: section at the end, typo heading, missing section, empty block", () => {
  assert.equal(appendBlockToTaskDescriptionContent("## Описание задачи\nстарое", "новое"), "## Описание задачи\nстарое\n\nновое\n");
  assert.equal(
    appendBlockToTaskDescriptionContent("## Описании задачи\n\n## Список подзадач\n", "новое"),
    "## Описании задачи\nновое\n\n## Список подзадач\n"
  );
  assert.equal(
    appendBlockToTaskDescriptionContent("---\na: 1\n---\n## Список подзадач\n- [ ] x\n", "новое"),
    "---\na: 1\n---\n\n## Описание задачи\nновое\n\n## Список подзадач\n- [ ] x\n"
  );
  assert.equal(appendBlockToTaskDescriptionContent("## Описание задачи\n", "  \n "), "## Описание задачи\n");
});

test("data reader keeps inbox creation times as a string map and omits them when absent", async () => {
  const storage = (data: unknown) => ({ loadData: async () => structuredClone(data), saveData: async () => undefined });
  const withTimes = await readDataFile(storage({ inbox: ["a"], inboxCreatedAt: { a: T1, b: 5 } }));
  assert.deepEqual(withTimes.inboxCreatedAt, { a: T1 });
  const without = await readDataFile(storage({ inbox: ["a"] }));
  assert.equal("inboxCreatedAt" in without, false);
});

test("trash: a deleted entry keeps when it was written and what it was linked to", () => {
  const store: { trash?: string[]; trashMeta?: Record<string, any> } = { trash: ["- [ ] напоминание (@29-09-2026)"] };
  addToTrash(store, "тест", { createdAt: T1, link: { task: "Trino ACL.md" } });
  assert.deepEqual(store.trash, ["- [ ] напоминание (@29-09-2026)", "тест"]);
  assert.deepEqual(store.trashMeta, { тест: { createdAt: T1, link: { task: "Trino ACL.md" } } });
  // Без сведений (как удаление напоминания) - карта не появляется и не растёт
  const plain: { trash?: string[]; trashMeta?: Record<string, any> } = {};
  addToTrash(plain, "x");
  assert.deepEqual(plain, { trash: ["x"] });
  // Повтор без сведений забирает их у строки (сведения - от последнего удаления); пустая привязка не хранится
  addToTrash(store, "тест", { createdAt: undefined, link: undefined });
  assert.deepEqual(store.trashMeta, {});
  addToTrash(store, "[Выполнено] y", { createdAt: T2, link: { project: "" } as any });
  assert.deepEqual(store.trashMeta, { "[Выполнено] y": { createdAt: T2 } });
  // Сведения строк, которых в корзине нет (очистила старая версия плагина), отбрасываются
  assert.deepEqual(pruneTrashMeta({ a: { createdAt: T1 }, b: { link: { project: "P" } }, c: "x", d: [] }, ["b", "c", "d"]), {
    b: { link: { project: "P" } },
  });
});

test("trash: a renamed task takes the links of trash entries along; the reader keeps only valid ones", async () => {
  const store = {
    trashMeta: { a: { createdAt: T1, link: { task: "Старое.md" } }, b: { link: { project: "Старое.md" } } },
  };
  assert.equal(renameInboxLinkTask(store, "Старое.md", "Новое.md"), true);
  assert.deepEqual(store.trashMeta, { a: { createdAt: T1, link: { task: "Новое.md" } }, b: { link: { project: "Старое.md" } } });

  const storage = (data: unknown) => ({ loadData: async () => structuredClone(data), saveData: async () => undefined });
  const data = await readDataFile(storage({ trash: ["a"], trashMeta: { a: { link: { task: "T.md" } }, gone: { createdAt: T1 } } }));
  assert.deepEqual(data.trashMeta, { a: { link: { task: "T.md" } } });
  assert.equal("trashMeta" in (await readDataFile(storage({ trash: ["a"] }))), false);
});

test("trash: deleted reminder lines are told apart from notepad entries", () => {
  assert.equal(isReminderTrashEntry("- [ ] позвонить (@29-09-2026 10:51)"), true);
  assert.equal(isReminderTrashEntry("  * [x] сделано (@2026-09-29)"), true);
  assert.equal(isReminderTrashEntry("- [ ] купить **2** [[X]] (@30-09-2026) (every 1 week)"), true);
  assert.equal(isReminderTrashEntry("- [ ] без даты"), false, "a checklist item without a date is a notepad entry");
  assert.equal(isReminderTrashEntry("тест\n![[Pasted image 1.png]]"), false);
  assert.equal(isReminderTrashEntry("[Выполнено] - [ ] x (@29-09-2026)"), false, "processed notepad entry");
});

test("trash: notepad entry text for markdown keeps list markers and drops only the archive mark", () => {
  assert.equal(getTrashEntryMarkdown("[Выполнено] текст\nвторая строка"), "текст\nвторая строка");
  assert.equal(getTrashEntryMarkdown("- первый пункт\n- второй"), "- первый пункт\n- второй");
});

// --- Привязка записи к задаче или проекту («Относится к») ---

test("link: a task or a project (non-empty strings); anything else is no link; the task wins", () => {
  assert.deepEqual(normalizeInboxLink({ task: " Trino ACL.md " }), { task: "Trino ACL.md" });
  assert.deepEqual(normalizeInboxLink({ project: "Trino" }), { project: "Trino" });
  assert.deepEqual(normalizeInboxLink({ task: "T.md", project: "P" }), { task: "T.md" });
  for (const bad of [null, "T.md", [], {}, { task: " " }, { project: 5 }]) assert.equal(normalizeInboxLink(bad), null);
  assert.deepEqual(pruneInboxLinks({ a: { task: "T.md" }, gone: { task: "T.md" }, b: { task: "" } }, ["a", "b"]), {
    a: { task: "T.md" },
  });
});

test("add with a link: stored next to the time; entries without a link leave data.json as before", () => {
  const store: InboxStore = { inbox: ["old"] };
  assert.equal(addInboxEntry(store, "без привязки", T1), "added");
  assert.equal("inboxLinks" in store, false, "no link field for people who do not use links");
  assert.equal(addInboxEntry(store, " мысль ", T2, { task: "Trino ACL.md" }), "added");
  assert.deepEqual(store.inboxLinks, { мысль: { task: "Trino ACL.md" } });
  assert.equal(addInboxEntry(store, "ещё", T2, { task: " " }), "added");
  assert.deepEqual(store.inboxLinks, { мысль: { task: "Trino ACL.md" } }, "an empty link is no link");
});

test("add a repeat with a link: an entry without one gets it, someone else's link stays", () => {
  const store: InboxStore = { inbox: ["позвонить", "написать"], inboxLinks: { написать: { project: "Spark" } } };
  assert.equal(addInboxEntry(store, "позвонить", T2, { task: "A.md" }), "exists");
  assert.equal(addInboxEntry(store, "написать", T2, { task: "B.md" }), "exists");
  assert.deepEqual(store.inboxLinks, { написать: { project: "Spark" }, позвонить: { task: "A.md" } });
  assert.deepEqual(store.inbox, ["позвонить", "написать"]);
});

test("add: a link left from a removed entry with the same text is not inherited", () => {
  // Запись «x» удалила версия плагина без привязок: привязка осталась под её текстом
  const store: InboxStore = { inbox: ["a"], inboxLinks: { x: { task: "Старая.md" } } };
  assert.equal(addInboxEntry(store, "x", T1), "added");
  assert.deepEqual(store.inboxLinks, {});
  assert.equal(addInboxEntry(store, "y", T1, { project: "P" }), "added");
  assert.deepEqual(store.inboxLinks, { y: { project: "P" } });
});

test("edit and remove: the link follows the text and comes back for the archive", () => {
  const store: InboxStore = { inbox: ["a", "b"], inboxCreatedAt: { a: T1 }, inboxLinks: { a: { task: "T.md" } } };
  assert.equal(editInboxEntry(store, "a", "a подробнее"), "updated");
  assert.deepEqual(store.inboxLinks, { "a подробнее": { task: "T.md" } });
  assert.deepEqual(removeInboxEntry(store, "a подробнее"), { removed: true, createdAt: T1, link: { task: "T.md" } });
  assert.deepEqual(store.inboxLinks, {});
  assert.deepEqual(removeInboxEntry(store, "b"), { removed: true });
});

test("renamed task: links of entries and of the archive follow it; unrelated renames change nothing", () => {
  const store = {
    inboxLinks: { a: { task: "Старое.md" }, b: { project: "Старое.md" }, c: { task: "Другое.md" } },
    inboxArchive: [
      { text: "x", completedAt: T1, link: { task: "Старое.md" } },
      { text: "y", completedAt: T1 },
    ],
  };
  assert.equal(renameInboxLinkTask(store, "Нет.md", "Тоже нет.md"), false);
  assert.equal(renameInboxLinkTask(store, "Старое.md", "Папка/Новое.md"), true);
  assert.deepEqual(store.inboxLinks, { a: { task: "Папка/Новое.md" }, b: { project: "Старое.md" }, c: { task: "Другое.md" } });
  assert.deepEqual(store.inboxArchive, [
    { text: "x", completedAt: T1, link: { task: "Папка/Новое.md" } },
    { text: "y", completedAt: T1 },
  ]);
});

test("data reader keeps only valid inbox links", async () => {
  const storage = (data: unknown) => ({ loadData: async () => structuredClone(data), saveData: async () => undefined });
  const data = await readDataFile(storage({ inbox: ["a"], inboxLinks: { a: { task: "T.md" }, b: "x", c: { project: "" } } }));
  assert.deepEqual(data.inboxLinks, { a: { task: "T.md" } });
  assert.equal("inboxLinks" in (await readDataFile(storage({ inbox: ["a"] }))), false);
});
