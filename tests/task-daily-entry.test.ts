import assert from "node:assert/strict";
import test from "node:test";
import { Modal, Notice, TFile, createMockApp } from "obsidian";
import { EventBus } from "../src/core/EventBus";
import { NoteTemplatesModule } from "../src/modules/NoteTemplatesModule";
import { DatePickerModal } from "../src/ui/DatePickerModal";

/**
 * Команда «Запись о задаче» без DOM: окно даты не строится - тест перехватывает его открытие и отвечает
 * за пользователя (Enter, ← и Enter, Esc), затем проверяет, в какую ежедневную заметку попал заголовок задачи
 * и какая заметка открылась.
 */
const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;

/** id команды прежний: по нему Obsidian хранит назначенный хоткей. */
const COMMAND_ID = "task-daily-entry-today";
const TASK_PATH = "Выдать доступ.md";
const HEADING = "### [[Выдать доступ]]";
/** Сейчас в тестах: понедельник 28-09-2026, 10:00. */
const NOW = new Date(2026, 8, 28, 10, 0);

const dailyPath = (date: string): string => `periodic/daily/${date}.md`;

/** Строка навигации новой ежедневной заметки (шаблон по умолчанию). */
function navLine(prev: string, next: string): string {
  return `← [[${dailyPath(prev)}|${prev}]]  |  [[${dailyPath(next)}|${next}]] →`;
}

/** Зафиксировать «сейчас» для `new Date()` и `Date.now()` на время run (как в reminders-module.test.ts). */
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

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Окна перехватываются: open() запоминает окно вместо построения DOM, setTitle - заголовок. */
function captureModals(): { opened: any[]; restore(): void } {
  const proto = Modal.prototype as any;
  const original = { open: proto.open, setTitle: proto.setTitle };
  const opened: any[] = [];
  proto.open = function (this: any) {
    opened.push(this);
  };
  proto.setTitle = function (this: any, title: string) {
    this.title = title;
    return this;
  };
  return { opened, restore: () => Object.assign(proto, original) };
}

interface Command {
  id: string;
  name: string;
  checkCallback?: (checking: boolean) => boolean;
}

function setup(files: Record<string, string> = {}) {
  const mock = createMockApp({ [TASK_PATH]: "---\nstatus: В работе\n---\n", ...files });
  mock.caches.set(TASK_PATH, { frontmatter: { status: "В работе" } });
  mock.vault.create = async (path: string, content: string) => mock.addFile(path, content);
  mock.vault.createFolder = async () => undefined;
  let activePath: string | null = TASK_PATH;
  const opened: string[] = [];
  Object.assign(mock.workspace, {
    getActiveFile: () => (activePath ? mock.files.get(activePath) ?? null : null),
    getLeavesOfType: () => [],
    getLeaf: () => ({
      openFile: async (file: TFile) => {
        opened.push(file.path);
      },
    }),
  });
  const commands: Command[] = [];
  const plugin = {
    settings: {},
    addCommand: (command: Command) => commands.push(command),
    registerEvent() {},
    registerMarkdownCodeBlockProcessor() {},
  };
  new NoteTemplatesModule({ app: mock.app, plugin, eventBus: new EventBus() } as any).load();
  const command = commands.find((c) => c.id === COMMAND_ID);
  assert.ok(command?.checkCallback, "команда зарегистрирована с прежним id");
  Notice.messages.length = 0;
  return {
    mock,
    opened,
    commands,
    run: (checking: boolean) => command.checkCallback!(checking),
    name: command.name,
    setActive(path: string | null) {
      activePath = path;
    },
  };
}

test("task entry command keeps its id under the new name and is available only in a task note", () => {
  const modals = captureModals();
  try {
    const template = "templates/task-templates/task-trino-acl.md";
    const env = setup({
      [dailyPath("27-09-2026")]: "",
      "Заметка.md": "Просто текст\n",
      [template]: "---\nstatus: В работе\n---\n",
    });
    env.mock.caches.set(template, { frontmatter: { status: "В работе" } });
    assert.equal(env.name, "Запись о задаче");
    assert.ok(!env.commands.some((c) => c.name.includes("за сегодня")));
    assert.equal(env.run(true), true);
    for (const path of [dailyPath("27-09-2026"), "Заметка.md", template, null]) {
      env.setActive(path);
      assert.equal(env.run(true), false, String(path));
    }
    // Проверка доступности окно даты не открывает
    assert.equal(modals.opened.length, 0);
  } finally {
    modals.restore();
  }
});

test("task entry: the date window opens on today and Enter writes into today's daily note", async () => {
  const modals = captureModals();
  try {
    await withFixedNow(NOW, async () => {
      const env = setup();
      assert.equal(env.run(false), true);
      assert.equal(modals.opened.length, 1);
      const picker = modals.opened[0];
      assert.ok(picker instanceof DatePickerModal);
      assert.equal(picker.title, "Дата записи");
      assert.deepEqual([picker.day, picker.month, picker.year], [28, 9, 2026]);
      // Пока окно открыто, ничего не записано и не открыто
      await flush();
      assert.deepEqual(env.opened, []);
      assert.equal(env.mock.files.size, 1);

      picker.confirm(); // Enter
      await flush();
      const today = dailyPath("28-09-2026");
      assert.deepEqual(env.opened, [today]);
      assert.equal(env.mock.contents.get(today), `${navLine("27-09-2026", "29-09-2026")}\n${HEADING}\n`);
      assert.deepEqual(Notice.messages, ["Создана ежедневная заметка: 28-09-2026"]);
    });
  } finally {
    modals.restore();
  }
});

test("task entry: ← and Enter write into yesterday's daily note, today's is not touched", async () => {
  const modals = captureModals();
  try {
    await withFixedNow(NOW, async () => {
      const yesterday = dailyPath("27-09-2026");
      const env = setup({ [yesterday]: `${navLine("26-09-2026", "28-09-2026")}\n\nУтро\n` });
      env.run(false);
      const picker = modals.opened[0];
      picker.refreshLabels = () => undefined; // подписи степперов - DOM, которого в тесте нет
      picker.changeDay(-1); // ←
      picker.confirm(); // Enter
      await flush();
      assert.deepEqual(env.opened, [yesterday]);
      assert.equal(env.mock.contents.get(yesterday), `${navLine("26-09-2026", "28-09-2026")}\n\nУтро\n\n${HEADING}\n`);
      assert.equal(env.mock.files.has(dailyPath("28-09-2026")), false);
      assert.deepEqual(Notice.messages, []);
    });
  } finally {
    modals.restore();
  }
});

test("task entry: an entry already started on the chosen day is reopened, not duplicated", async () => {
  const modals = captureModals();
  try {
    await withFixedNow(NOW, async () => {
      const day = dailyPath("25-09-2026");
      const content = `${navLine("24-09-2026", "26-09-2026")}\n\n${HEADING}\nВыдал роль\n\n### [[Другая задача]]\n`;
      const env = setup({ [day]: content });
      env.run(false);
      modals.opened[0].finish(new Date(2026, 8, 25)); // в окне выбран день 25-09-2026
      await flush();
      assert.deepEqual(env.opened, [day]);
      assert.equal(env.mock.contents.get(day), content);
    });
  } finally {
    modals.restore();
  }
});

test("task entry: cancelling the date window writes and opens nothing", async () => {
  const modals = captureModals();
  try {
    const env = setup();
    env.run(false);
    modals.opened[0].close(); // Esc или клик вне окна
    await flush();
    assert.deepEqual(env.opened, []);
    assert.deepEqual([...env.mock.files.keys()], [TASK_PATH]);
    assert.deepEqual(Notice.messages, []);
  } finally {
    modals.restore();
  }
});
