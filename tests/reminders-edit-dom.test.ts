import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Modal, Notice, createMockApp } from "obsidian";
import { EventBus } from "../src/core/EventBus";
import { RemindersIndex } from "../src/core/RemindersIndex";
import { RemindersModule } from "../src/modules/RemindersModule";

/**
 * Блок напоминаний в DOM: «Изменить» открывает окно напоминания с текущими значениями (правки строки на месте
 * больше нет), «Сохранить» пишет в заметку и блок показывает новый срок.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.org/", pretendToBeVisual: true });
const { window } = dom;
const document = window.document;
(globalThis as any).window = window;
(globalThis as any).document = document;
(globalThis as any).Node = window.Node;
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).localStorage = window.localStorage;

// DOM-хелперы Obsidian (createEl/empty/addClass…); у createEl - и type/value/placeholder, как в DomElementInfo
type CreateOpts =
  | { text?: string; cls?: string; attr?: Record<string, string>; type?: string; value?: string; placeholder?: string }
  | string;
const proto = window.HTMLElement.prototype as any;
proto.createEl = function (tag: string, opts?: CreateOpts) {
  const el = document.createElement(tag) as any;
  if (typeof opts === "string") el.className = opts;
  else if (opts) {
    if (opts.cls) el.className = opts.cls;
    if (opts.type) el.setAttribute("type", opts.type);
    if (opts.text != null) el.textContent = opts.text;
    if (opts.value != null) el.value = opts.value;
    if (opts.placeholder != null) el.setAttribute("placeholder", opts.placeholder);
    if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, String(v));
  }
  this.appendChild(el);
  return el;
};
proto.createDiv = function (opts?: CreateOpts) {
  return this.createEl("div", opts);
};
proto.empty = function () {
  while (this.firstChild) this.removeChild(this.firstChild);
};
proto.addClass = function (...cls: string[]) {
  this.classList.add(...cls);
};
proto.removeClass = function (...cls: string[]) {
  this.classList.remove(...cls);
};
proto.toggleClass = function (cls: string, on: boolean) {
  this.classList.toggle(cls, on);
};
proto.hasClass = function (cls: string) {
  return this.classList.contains(cls);
};
proto.setText = function (text: string) {
  this.textContent = text;
};

const DATA_PATH = ".obsidian/plugins/opa/data.json";

function setup(files: Record<string, string>) {
  Notice.messages.length = 0;
  Modal.opened = [];
  window.localStorage.clear();
  document.body.empty();
  const mock = createMockApp(files);
  let data: Record<string, unknown> = {};
  const plugin = {
    settings: {
      enableReminders: true,
      enableGamification: false,
      gamificationReminderRewards: { xp: 2, gold: 1 },
      gamificationStreakGraceDays: 0,
    },
    loadData: async () => structuredClone(data),
    saveData: async (value: unknown) => {
      data = structuredClone(value) as Record<string, unknown>;
    },
    getGamificationDataPath: () => DATA_PATH,
    registerEvent() {},
  };
  const index = new RemindersIndex(mock.app, plugin);
  const module = new RemindersModule({
    app: mock.app,
    plugin,
    taskIndex: null,
    remindersIndex: index,
    eventBus: new EventBus(),
  } as never);
  const internals = module as unknown as {
    registry: { register(el: HTMLElement, refresh: (force: boolean) => Promise<void>): void };
    render(el: HTMLElement, force?: boolean): Promise<void>;
    scheduleCheckAfterNotification: () => void;
    verifyIndexSoon: () => void;
  };
  // Таймеры уведомлений и контрольная перечитка файла здесь не нужны
  internals.scheduleCheckAfterNotification = () => undefined;
  internals.verifyIndexSoon = () => undefined;

  /** Блок `opa-reminders-view`, как его регистрирует code block processor. */
  const mountBlock = (): HTMLElement => {
    const block = document.body.appendChild(document.createElement("div"));
    block.className = "opa-reminders-view";
    internals.registry.register(block, (force) => internals.render(block, force));
    return block;
  };
  return { mock, index, module, mountBlock };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function windowParts() {
  assert.equal(Modal.opened.length, 1, "открыто одно окно");
  const content = Modal.opened[0].contentEl as HTMLElement;
  const [text, date] = [...content.querySelectorAll<HTMLInputElement>("input.opa-reminder-modal-input")];
  return {
    title: content.querySelector("h2")?.textContent,
    text,
    date,
    amount: content.querySelector<HTMLInputElement>(".reminder-modal-recur-amount")!,
    unit: content.querySelector<HTMLSelectElement>(".reminder-modal-recur-unit")!,
    save: content.querySelector<HTMLButtonElement>("button.mod-cta")!,
    cancel: content.querySelector<HTMLButtonElement>("button.reminder-modal-cancel")!,
  };
}

test("«Изменить» opens the reminder window with the current values; Save writes the new date into the note", async () => {
  const { mock, index, module, mountBlock } = setup({
    "Пылесос.md": "- [ ] Почистить робот пылесос (every 2 months) (@05-10-2099 19:00)",
  });
  await index.buildFull();
  const block = mountBlock();
  await waitFor(() => block.querySelector(".rv-item") != null, "the reminder row");

  const row = block.querySelector(".rv-item")!;
  const editBtn = [...row.querySelectorAll<HTMLButtonElement>(".rv-actions button")].find((b) => b.textContent === "Изменить");
  assert.ok(editBtn, "кнопка «Изменить» на месте");
  editBtn.click();

  const w = windowParts();
  assert.equal(w.title, "Изменить напоминание");
  assert.equal(w.text.value, "Почистить робот пылесос");
  assert.equal(w.date.getAttribute("type"), "datetime-local");
  assert.equal(w.date.value, "2099-10-05T19:00");
  assert.equal(w.amount.value, "2");
  assert.equal(w.unit.value, "months");
  assert.equal(row.querySelector("input:not([type=checkbox])"), null, "в строке блока поля правки нет");

  w.date.value = "2099-10-12T09:30";
  w.save.click();
  await waitFor(() => (mock.contents.get("Пылесос.md") ?? "").includes("12-10-2099"), "the note to be written");
  assert.equal(mock.contents.get("Пылесос.md"), "- [ ] Почистить робот пылесос (every 2 months) (@12-10-2099 09:30)");
  assert.equal(Modal.opened.length, 0, "окно закрылось");
  await waitFor(
    () => block.querySelector(".rv-badge-date")?.textContent === "12-10-2099 09:30",
    "the block to show the new date"
  );
  assert.ok(Notice.messages.includes("Напоминание обновлено"));
  module.unload();
});

test("«Изменить»: turning recurrence off in the window removes the tag; Cancel leaves the note as it was", async () => {
  const { mock, index, module, mountBlock } = setup({
    "Notes.md": "- [ ] Отчёт (every 1 week) (@05-10-2099)",
  });
  await index.buildFull();
  const block = mountBlock();
  await waitFor(() => block.querySelector(".rv-item") != null, "the reminder row");
  const clickEdit = () =>
    [...block.querySelectorAll<HTMLButtonElement>(".rv-item .rv-actions button")].find((b) => b.textContent === "Изменить")!.click();

  clickEdit();
  let w = windowParts();
  assert.equal(w.date.value, "2099-10-05T10:00", "без времени в теге - 10:00, как у уведомления");
  assert.equal(w.amount.value, "1");
  assert.equal(w.unit.value, "weeks", "week в строке - «Недель» в окне");
  w.text.value = "Отчёт за неделю";
  w.cancel.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(mock.contents.get("Notes.md"), "- [ ] Отчёт (every 1 week) (@05-10-2099)");

  clickEdit();
  w = windowParts();
  assert.equal(w.text.value, "Отчёт", "после отмены окно снова открывается с текстом из строки");
  w.unit.value = "";
  w.save.click();
  await waitFor(() => !(mock.contents.get("Notes.md") ?? "").includes("every"), "the recurrence to be removed");
  assert.equal(mock.contents.get("Notes.md"), "- [ ] Отчёт (@05-10-2099)", "дата без времени не тронута");
  module.unload();
});

test("the new-reminder window keeps its defaults: title, no recurrence, amount 1", async () => {
  const { module } = setup({});
  const pending = module.openReminderModal("Позвонить");
  const w = windowParts();
  assert.equal(w.title, "Настройка напоминания");
  assert.equal(w.text.value, "Позвонить");
  assert.equal(w.unit.value, "");
  assert.equal(w.amount.value, "1");
  assert.match(w.date.value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  w.cancel.click();
  assert.equal(await pending, null);
  module.unload();
});

test("Enter in a field of the window saves, Enter on «Отмена» does not", async () => {
  const { mock, index, module, mountBlock } = setup({ "Notes.md": "- [ ] Позвонить (@05-10-2099 19:00)" });
  await index.buildFull();
  const block = mountBlock();
  await waitFor(() => block.querySelector(".rv-item") != null, "the reminder row");
  [...block.querySelectorAll<HTMLButtonElement>(".rv-item .rv-actions button")].find((b) => b.textContent === "Изменить")!.click();

  const w = windowParts();
  w.text.value = "Позвонить маме";
  w.cancel.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(Modal.opened.length, 1, "Enter на «Отмена» не сохраняет");
  assert.equal(mock.contents.get("Notes.md"), "- [ ] Позвонить (@05-10-2099 19:00)");

  w.text.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitFor(() => (mock.contents.get("Notes.md") ?? "").includes("маме"), "the note to be written");
  assert.equal(mock.contents.get("Notes.md"), "- [ ] Позвонить маме (@05-10-2099 19:00)");
  module.unload();
});
