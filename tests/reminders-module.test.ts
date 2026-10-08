import assert from "node:assert/strict";
import test from "node:test";
import { Notice, TFile, createMockApp } from "obsidian";
import { EventBus } from "../src/core/EventBus";
import { RemindersIndex } from "../src/core/RemindersIndex";
import { RemindersModule, type ReminderModalOptions } from "../src/modules/RemindersModule";
import { buildReminderLine, type ReminderData, type ReminderItem } from "../src/core/ReminderDataUtils";

/**
 * Файловые сценарии модуля напоминаний (без DOM): выполнение из блока для заметки и для data.json,
 * обработка правки заметки пользователем, награды через маркер-намерение. Блоки и окна здесь не строятся,
 * поэтому достаточно заглушек window/document для таймеров и реестра блоков.
 */
const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
g.document ??= { querySelectorAll: () => [], querySelector: () => null };

const DATA_PATH = ".obsidian/plugins/opa/data.json";

/**
 * Зафиксировать «сейчас» для `new Date()` и `Date.now()` на время run. Своя подмена вместо
 * `t.mock.timers.enable({ apis: ["Date"] })`: та форма вызова есть только в Node 20.10+.
 */
async function withFixedNow<T>(fixed: Date, run: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixedMs = fixed.getTime();
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      super(...((args.length === 0 ? [fixedMs] : args) as [number]));
    }
    static now(): number {
      return fixedMs;
    }
  }
  (globalThis as { Date: typeof Date }).Date = FixedDate as unknown as typeof Date;
  try {
    return await run();
  } finally {
    (globalThis as { Date: typeof Date }).Date = RealDate;
  }
}

class MemoryStorage {
  data: Record<string, unknown>;
  constructor(data: Record<string, unknown> = {}) {
    this.data = structuredClone(data);
  }
  async loadData() {
    return structuredClone(this.data);
  }
  async saveData(data: unknown) {
    this.data = structuredClone(data) as Record<string, unknown>;
  }
}

function setup(files: Record<string, string>, data: Record<string, unknown> = {}, gamification = true) {
  const mock = createMockApp(files);
  const storage = new MemoryStorage(data);
  const plugin = {
    settings: {
      enableReminders: true,
      enableGamification: gamification,
      gamificationReminderRewards: { xp: 2, gold: 1 },
      gamificationStreakGraceDays: 0,
    },
    loadData: () => storage.loadData(),
    saveData: (value: unknown) => storage.saveData(value),
    getGamificationDataPath: () => DATA_PATH,
    registerEvent() {},
    registerInterval() {},
    registerDomEvent() {},
    registerMarkdownCodeBlockProcessor() {},
    refreshGamificationState: async () => undefined,
    gamification: null,
  };
  const index = new RemindersIndex(mock.app, plugin);
  const module = new RemindersModule({
    app: mock.app,
    plugin,
    taskIndex: null,
    remindersIndex: index,
    eventBus: new EventBus(),
  } as never) as RemindersModule & Record<string, (...args: never[]) => unknown>;
  // Контрольная перечитка через 2,3 с здесь не нужна (индекс обновляется из записанного текста сразу)
  (module as unknown as { verifyIndexSoon: () => void }).verifyIndexSoon = () => undefined;
  Notice.messages.length = 0;
  return { mock, storage, plugin, index, module: module as unknown as {
    completeReminder(item: ReminderItem): Promise<boolean>;
    handleFileChanged(file: TFile): Promise<void>;
    writeOwnChange(file: TFile, transform: (content: string) => string): Promise<string | null>;
    muteItemAfterFailure(item: ReminderItem): void;
    delayWhileDueItemsMuted(): number | null;
    scheduleNextReminderCheck(): Promise<void>;
    runReminderCheck(): Promise<void>;
    stopChecker(): void;
    nextCheckTimeoutId: unknown;
    notificationModalOpen: boolean;
    unload(): void;
  } };
}

test("completing a note reminder from the block: checkbox, reward once, marker removed, index updated", async () => {
  const { mock, storage, index, module } = setup({
    "Notes.md": "# Заметка\n- [ ] Позвонить (@01-07-2026 10:00)\n",
  });
  await index.buildFull();
  const item = index.getReminderData().overdue[0];
  assert.equal(item.text, "Позвонить");

  assert.equal(await module.completeReminder(item), true);
  assert.equal(mock.contents.get("Notes.md"), "# Заметка\n- [x] Позвонить (@01-07-2026 10:00)\n");
  const gamification = storage.data.gamification as { xp: number; gold: number; shop?: unknown };
  assert.equal(gamification.xp, 2);
  assert.equal(gamification.gold, 1);
  assert.equal(gamification.shop, undefined, "магазин остаётся незаданным - его заполнят дефолты");
  assert.equal((storage.data.reminderRewardIds as string[]).length, 1);
  assert.deepEqual(index.getFilesWithRewardMarkers(), []);
  assert.equal(index.getReminderData().overdue.length, 0);
  assert.deepEqual(index.getReminderData().completed.map((i) => i.text), ["Позвонить"]);
  assert.ok(Notice.messages.includes("Напоминание выполнено +2 XP, +1 Gold"));

  // Повторное выполнение той же строки: не найдена, награда не удваивается
  assert.equal(await module.completeReminder(item), false);
  assert.equal((storage.data.gamification as { xp: number }).xp, 2);
  module.unload();
});

test("completing a recurring note reminder inserts the next occurrence and grows the streak", async () => {
  const { mock, storage, index, module } = setup({
    "Notes.md": "- [ ] Отчёт (every 1 week) (@01-07-2026 10:00)",
  });
  await index.buildFull();
  const item = index.getReminderData().overdue[0];
  assert.equal(item.isRecurring, true);

  assert.equal(await module.completeReminder(item), true);
  const lines = (mock.contents.get("Notes.md") ?? "").split("\n");
  assert.equal(lines[0], "- [x] Отчёт (@01-07-2026 10:00)");
  assert.match(lines[1], /^- \[ \] Отчёт \(every 1 week\) \(@\d{2}-\d{2}-\d{4} 10:00\)$/);
  assert.equal(lines.length, 2);
  // Выполнено много позже срока - стрик начинается с 1. Ключ стрика - текст напоминания как он показан
  // в блоке (с тегом повторения): так было всегда, и под этими ключами лежат накопленные стрики пользователей.
  assert.deepEqual((storage.data.gamification as { streaks: Record<string, number> }).streaks, {
    "Отчёт (every 1 week)": 1,
  });
  const data = index.getReminderData();
  assert.equal(data.completed.length, 1);
  assert.equal(data.overdue.length + data.today.length + data.tomorrow.length + data.upcoming.length, 1);
  assert.ok(Notice.messages.some((m) => m.startsWith("Создана следующая задача")));
  module.unload();
});

test("completing a data.json reminder applies the reward in the same write and refreshes the index", async () => {
  const { storage, index, module } = setup({}, { reminders: ["- [ ] Data (@01-07-2026 10:00)"] });
  await index.buildFull();
  const item = index.getReminderData().overdue[0];
  assert.equal(item.filePath, DATA_PATH);

  assert.equal(await module.completeReminder(item), true);
  assert.deepEqual(storage.data.reminders, ["- [x] Data (@01-07-2026 10:00)"]);
  assert.equal((storage.data.gamification as { xp: number }).xp, 2);
  assert.deepEqual(storage.data.reminderRewardIds, [], "маркеры-намерения нужны только для заметок");
  assert.equal(index.getReminderData().completed.length, 1);
  module.unload();
});

test("without gamification completing a reminder writes no reward and no marker", async () => {
  const { mock, storage, index, module } = setup({ "Notes.md": "- [ ] Тихо (@01-07-2026 10:00)" }, {}, false);
  await index.buildFull();
  assert.equal(await module.completeReminder(index.getReminderData().overdue[0]), true);
  assert.equal(mock.contents.get("Notes.md"), "- [x] Тихо (@01-07-2026 10:00)");
  assert.equal(storage.data.gamification, undefined);
  assert.ok(Notice.messages.includes("Напоминание выполнено"));
  module.unload();
});

test("a user edit that completes a recurring line in the note gets the next occurrence, idempotently", async () => {
  const { mock, index, module } = setup({
    "Notes.md": "- [x] Отчёт (every 1 week) (@01-07-2026 10:00)\nпросто текст",
  });
  await index.buildFull();
  const file = mock.files.get("Notes.md") as TFile;

  await module.handleFileChanged(file);
  const after = mock.contents.get("Notes.md") ?? "";
  const lines = after.split("\n");
  assert.equal(lines[0], "- [x] Отчёт (@01-07-2026 10:00)");
  assert.match(lines[1], /^- \[ \] Отчёт \(every 1 week\) \(@\d{2}-\d{2}-\d{4} 10:00\)$/);
  assert.equal(lines[2], "просто текст");
  assert.equal(index.getReminderData().completed.length, 1);

  await module.handleFileChanged(file);
  assert.equal(mock.contents.get("Notes.md"), after, "второй проход ничего не меняет");
  module.unload();
});

test("a reward marker left in a note after a crash is applied once and removed", async () => {
  const marker = "<!-- opa-reminder-reward:crash1:3:1 -->";
  const { mock, storage, index, module } = setup({
    "Notes.md": `- [x] Done (@01-07-2026 10:00) ${marker}`,
  });
  await index.buildFull();
  assert.deepEqual(index.getFilesWithRewardMarkers(), ["Notes.md"]);
  const file = mock.files.get("Notes.md") as TFile;

  await module.handleFileChanged(file);
  assert.equal(mock.contents.get("Notes.md"), "- [x] Done (@01-07-2026 10:00)");
  assert.equal((storage.data.gamification as { xp: number }).xp, 3);
  assert.deepEqual(storage.data.reminderRewardIds, ["crash1"]);
  assert.deepEqual(index.getFilesWithRewardMarkers(), []);

  await module.handleFileChanged(file);
  assert.equal((storage.data.gamification as { xp: number }).xp, 3, "награда не начисляется повторно");
  module.unload();
});

test("while every due reminder is muted the checker waits for the mute end or the next trigger, whichever is sooner", async () => {
  // Тег напоминания хранит минуты, поэтому «сейчас» фиксируем: 11:59:30, следующее напоминание - в 12:00
  await withFixedNow(new Date(2026, 6, 1, 11, 59, 30), async () => {
    const { index, module } = setup({
      "Notes.md": [
        "- [ ] Просрочено (@01-07-2026 10:00)",
        buildReminderLine("Скоро", new Date(2026, 6, 1, 12, 0)),
      ].join("\n"),
    });
    await index.buildFull();
    const data = index.getReminderData();
    assert.deepEqual(data.overdue.map((item) => item.text), ["Просрочено"]);
    assert.deepEqual(data.today.map((item) => item.text), ["Скоро"]);
    // Просроченное не замолчало - проверять как обычно
    assert.equal(module.delayWhileDueItemsMuted(), null);

    module.muteItemAfterFailure(data.overdue[0]);
    // Молчание длится 60 с, но «Скоро» наступает через 30 с - ждём его, а не конца молчания
    assert.equal(module.delayWhileDueItemsMuted(), 30_000);

    await module.scheduleNextReminderCheck();
    assert.ok(module.nextCheckTimeoutId != null, "таймер проверки заведён");
    module.stopChecker();
    module.unload();
  });
});

test("after unload the checker neither arms timers nor opens notifications", async () => {
  const { index, module } = setup({ "Notes.md": "- [ ] Просрочено (@01-07-2026 10:00)" });
  await index.buildFull();
  module.unload();
  await module.scheduleNextReminderCheck();
  assert.equal(module.nextCheckTimeoutId, null);
  await module.runReminderCheck();
  assert.equal(module.notificationModalOpen, false);
});

test("writeOwnChange returns null and leaves the index alone when nothing changes", async () => {
  const { mock, index, module } = setup({ "Notes.md": "- [ ] Позвонить (@01-07-2026 10:00)" });
  await index.buildFull();
  const file = mock.files.get("Notes.md") as TFile;
  assert.equal(await module.writeOwnChange(file, (content) => content), null);
  assert.equal(await module.writeOwnChange(file, () => "- [ ] Позвонить (@02-07-2026 10:00)"), "- [ ] Позвонить (@02-07-2026 10:00)");
  assert.equal(index.getReminderData().overdue[0].displayDate, "02-07-2026");
  module.unload();
});

test("command «Новое напоминание»: the selection becomes the reminder text in one line, the reminder is saved", async () => {
  const { mock, storage, plugin, module } = setup({});
  const commands: Array<{ id: string; name: string; checkCallback: (checking: boolean) => boolean }> = [];
  (plugin as unknown as { addCommand: (c: (typeof commands)[number]) => void }).addCommand = (c) => commands.push(c);
  const reminders = module as unknown as {
    registerCommands(): void;
    addReminderFromCommand(): Promise<void>;
    openReminderModal: (text: string) => Promise<{ text: string; date: Date; recurrence: string } | null>;
    afterExternalDataChange: () => Promise<void>;
  };
  reminders.registerCommands();
  const command = commands.find((c) => c.id === "reminders-add")!;
  assert.equal(command.name, "Новое напоминание");
  assert.equal(command.checkCallback(true), true);
  plugin.settings.enableReminders = false;
  assert.equal(command.checkCallback(true), false, "unavailable while reminders are off");
  plugin.settings.enableReminders = true;

  (mock.app.workspace as Record<string, unknown>).activeEditor = {
    editor: { getSelection: () => "Позвонить Y\nпо поводу доступа" },
  };
  let prefilled = "";
  reminders.openReminderModal = async (text) => {
    prefilled = text;
    return { text, date: new Date(2026, 9, 1, 10, 0), recurrence: "every 1 week" };
  };
  reminders.afterExternalDataChange = async () => undefined;
  await reminders.addReminderFromCommand();
  assert.equal(prefilled, "Позвонить Y по поводу доступа");
  assert.deepEqual(storage.data.reminders, ["- [ ] Позвонить Y по поводу доступа (every 1 week) (@01-10-2026 10:00)"]);
  assert.ok(Notice.messages.includes("Напоминание добавлено: 01-10-2026 10:00"));

  // Отмена в окне - ничего не добавляется
  reminders.openReminderModal = async () => null;
  await reminders.addReminderFromCommand();
  assert.equal((storage.data.reminders as string[]).length, 1);
  module.unload();
});

// ---------------------------------------------------------------------------
// «Изменить»: окно напоминания вместо правки строки на месте
// ---------------------------------------------------------------------------

type ReminderWindowResult = { text: string; date: Date; recurrence: string } | null;

/** Модуль с окном-заглушкой: answer - что «нажал» пользователь; opened - с чем окно открывалось. */
function withEditWindow(module: unknown, answer: (text: string, options: ReminderModalOptions) => ReminderWindowResult) {
  const reminders = module as {
    editReminderFromBlock(item: ReminderItem): Promise<void>;
    openReminderModal: (text: string, options?: ReminderModalOptions) => Promise<ReminderWindowResult>;
    scheduleCheckAfterNotification: () => void;
  };
  const opened: Array<{ text: string; options: ReminderModalOptions }> = [];
  const checks: number[] = [];
  reminders.openReminderModal = async (text, options = {}) => {
    opened.push({ text, options });
    return answer(text, options);
  };
  // Перепланирование уведомлений проверяется по факту вызова: настоящий таймер в тесте не нужен
  reminders.scheduleCheckAfterNotification = () => void checks.push(Date.now());
  return { edit: (item: ReminderItem) => reminders.editReminderFromBlock(item), opened, checks };
}

const activeItems = (data: ReminderData): ReminderItem[] => [...data.overdue, ...data.today, ...data.tomorrow, ...data.upcoming];

test("«Изменить»: the window opens with the reminder's text, date and recurrence, only the new date is written", async () => {
  const { mock, index, module } = setup({
    "Пылесос.md": "# Обслуживание\n  - [ ] Почистить робот пылесос (every 2 months) (@05-10-2026 19:00) ^vac\nконец",
  });
  await index.buildFull();
  const { edit, opened, checks } = withEditWindow(module, (text) => ({
    text,
    date: new Date(2026, 9, 12, 9, 30),
    recurrence: "every 2 months",
  }));

  await edit(activeItems(index.getReminderData())[0]);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].text, "Почистить робот пылесос", "в поле текста нет тегов даты и повторения");
  assert.equal(opened[0].options.title, "Изменить напоминание");
  assert.equal(opened[0].options.date?.getTime(), new Date(2026, 9, 5, 19, 0).getTime());
  assert.deepEqual(opened[0].options.recurrence, { amount: 2, unit: "months" });

  // Отступ вложенного напоминания и id блока остаются (раньше правка на месте убирала отступ)
  assert.equal(
    mock.contents.get("Пылесос.md"),
    "# Обслуживание\n  - [ ] Почистить робот пылесос (every 2 months) (@12-10-2026 09:30) ^vac\nконец"
  );
  assert.deepEqual(activeItems(index.getReminderData()).map((item) => item.displayDate), ["12-10-2026"]);
  assert.ok(Notice.messages.includes("Напоминание обновлено"));
  assert.equal(checks.length, 1, "срок изменился - таймер уведомлений заводится заново");
  module.unload();
});

test("«Изменить» for a data.json reminder: cancel and an unchanged save write nothing, a real change is saved", async () => {
  const { storage, index, module } = setup({}, { reminders: ["- [ ] Полить цветы (@05-10-2026 19:00)"] });
  await index.buildFull();
  const item = activeItems(index.getReminderData())[0];
  let answer: (text: string, options: ReminderModalOptions) => ReminderWindowResult = () => null;
  const { edit } = withEditWindow(module, (text, options) => answer(text, options));

  await edit(item);
  answer = (text, options) => ({ text: `  ${text} `, date: options.date ?? new Date(NaN), recurrence: "" });
  await edit(item);
  assert.deepEqual(storage.data.reminders, ["- [ ] Полить цветы (@05-10-2026 19:00)"]);
  assert.deepEqual(Notice.messages, [], "без изменений - ни записи, ни уведомления");

  answer = (_text, options) => ({ text: "Полить фикус", date: options.date ?? new Date(NaN), recurrence: "every 3 days" });
  await edit(item);
  assert.deepEqual(storage.data.reminders, ["- [ ] Полить фикус (every 3 days) (@05-10-2026 19:00)"]);
  assert.deepEqual(activeItems(index.getReminderData()).map((i) => i.text), ["Полить фикус (every 3 days)"]);
  assert.ok(Notice.messages.includes("Напоминание обновлено"));
  module.unload();
});

test("«Изменить» when the line changed while the window was open: nothing is overwritten, the user is told", async () => {
  const { mock, index, module } = setup({ "Notes.md": "- [ ] Позвонить (@05-10-2026 19:00)" });
  await index.buildFull();
  const { edit } = withEditWindow(module, (text) => {
    mock.contents.set("Notes.md", "- [ ] Позвонить маме (@06-10-2026 10:00)");
    return { text, date: new Date(2026, 9, 7, 10, 0), recurrence: "" };
  });
  await edit(activeItems(index.getReminderData())[0]);
  assert.equal(mock.contents.get("Notes.md"), "- [ ] Позвонить маме (@06-10-2026 10:00)");
  assert.ok(Notice.messages.includes("Напоминание не изменено: его уже изменили или удалили."));
  module.unload();
});

test("the check timer waits at most an hour, even when the next reminder is a month away", async () => {
  await withFixedNow(new Date(2026, 6, 1, 12, 0), async () => {
    // 30 суток - больше, чем вмещает задержка setTimeout (2^31 - 1 мс, около 24,8 суток)
    const { index, module } = setup({ "Notes.md": "- [ ] Через месяц (@31-07-2026 12:00)" });
    await index.buildFull();
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((_fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(() => undefined, 0);
    }) as typeof setTimeout;
    try {
      await module.scheduleNextReminderCheck();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    module.stopChecker();
    assert.deepEqual(delays, [60 * 60 * 1000]);
    module.unload();
  });
});
