import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOutlineTree,
  cleanHeadingText,
  collectCollapsibleIds,
  filterOutlineTree,
  findPluginBlocks,
  findTaskViewBlockLine,
  headingMatchKey,
  outlineSignature,
  type OutlineNode,
  type OutlineTocItem,
} from "../src/core/OutlineTree";

function tocItem(text: string, dateText: string, extra: Partial<OutlineTocItem> = {}): OutlineTocItem {
  return {
    text,
    level: 1,
    dateText,
    isDateOnly: false,
    entryKey: `periodic/daily/${dateText}.md::### [[Task]]`,
    entryOrdinal: 0,
    subIndex: 0,
    occurrence: 0,
    sourcePath: `periodic/daily/${dateText}.md`,
    line: 3,
    ...extra,
  };
}

/** Дерево в виде строк с отступами: удобно сравнивать целиком. */
function render(nodes: OutlineNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${"  ".repeat(depth)}${node.text}${node.suffix ? ` (${node.suffix})` : ""}`,
    ...render(node.children, depth + 1),
  ]);
}

const TASK_HEADINGS = [
  { text: "Описание задачи", level: 2, line: 3 },
  { text: "Критерий выполнения", level: 2, line: 5 },
  { text: "Список подзадач", level: 2, line: 7 },
];

test("cleanHeadingText strips markdown but keeps identifiers with underscores", () => {
  assert.equal(cleanHeadingText("[[ETG. Включение cache для iceberg_rest_vertica каталога]]"), "ETG. Включение cache для iceberg_rest_vertica каталога");
  assert.equal(cleanHeadingText("[[periodic/daily/18-08-2026.md#Task|18-08-2026]]"), "18-08-2026");
  assert.equal(cleanHeadingText("[[Заметка#Раздел]]"), "Заметка > Раздел");
  assert.equal(cleanHeadingText("[[#Раздел]]"), "Раздел");
  assert.equal(cleanHeadingText("**Образ** и `kubectl` ==важно== ~~старое~~"), "Образ и kubectl важно старое");
  assert.equal(cleanHeadingText("*курсив* и _тоже_ курсив"), "курсив и тоже курсив");
  assert.equal(cleanHeadingText("snake_case_name и 2 * 3 * 4"), "snake_case_name и 2 * 3 * 4");
  assert.equal(cleanHeadingText("[ссылка](https://example.com) <b>html</b>"), "ссылка html");
  assert.equal(cleanHeadingText("Заголовок ##"), "Заголовок");
  assert.equal(cleanHeadingText("**"), "**");
  assert.equal(headingMatchKey("  Временный   **кэш** "), "временный кэш");
  // Блок задачи убирает из подзаголовков все «#», в отрисованном тексте они есть
  assert.equal(headingMatchKey("C# и Issue #42 #тег"), headingMatchKey("C и Issue 42 тег"));
});

test("findTaskViewBlockLine finds the block outside frontmatter and other fences", () => {
  const note = ["---", "status: В работе", "---", "## Описание задачи", "", "## Список подзадач", "- [ ] ", "", "```opa-task-view", "```", ""].join("\n");
  assert.equal(findTaskViewBlockLine(note), 8);
  assert.equal(findTaskViewBlockLine(note.replace(/\n/g, "\r\n")), 8);
  assert.equal(findTaskViewBlockLine("~~~opa-task-view\n~~~"), 0);
  // Пример блока внутри другого блока кода - не блок
  const example = ["````markdown", "```opa-task-view", "```", "````", "текст"].join("\n");
  assert.equal(findTaskViewBlockLine(example), null);
  const afterExample = example + "\n```opa-task-view\n```";
  assert.equal(findTaskViewBlockLine(afterExample), 5);
  assert.equal(findTaskViewBlockLine("```bash\necho\n```\n"), null);
  assert.equal(findTaskViewBlockLine(""), null);
});

test("buildOutlineTree puts TOC items of the task view after the note headings, at the top level", () => {
  const items = [
    tocItem("Образ", "18-08-2026", { subIndex: 0 }),
    tocItem("Подготовка нод", "18-08-2026", { subIndex: 1 }),
    tocItem("Ресерч", "18-08-2026", { subIndex: 2 }),
    tocItem("Временный кэш на системном диске", "01-09-2026", { subIndex: 0 }),
  ];
  const tree = buildOutlineTree(TASK_HEADINGS, { line: 10, items });
  assert.deepEqual(render(tree), [
    "Описание задачи",
    "Критерий выполнения",
    "Список подзадач",
    "Образ (18-08-2026)",
    "Подготовка нод (18-08-2026)",
    "Ресерч (18-08-2026)",
    "Временный кэш на системном диске (01-09-2026)",
  ]);
  assert.equal(tree[3].kind, "entry");
  assert.equal(tree[3].item?.sourcePath, "periodic/daily/18-08-2026.md");
  assert.equal(tree[0].kind, "heading");
  assert.equal(tree[0].line, 3);
});

test("buildOutlineTree nests deeper subheadings of records and keeps later note headings out of them", () => {
  const items = [
    tocItem("Итог", "02-09-2026", { level: 1, subIndex: 0 }),
    tocItem("Детали", "02-09-2026", { level: 2, subIndex: 1 }),
    tocItem("Ещё", "03-09-2026", { level: 1, subIndex: 0 }),
  ];
  const headings = [
    { text: "Раздел", level: 2, line: 0 },
    { text: "Подраздел", level: 3, line: 2 },
    { text: "После блока", level: 3, line: 12 },
    { text: "Последний", level: 2, line: 14 },
  ];
  const tree = buildOutlineTree(headings, { line: 5, items });
  assert.deepEqual(render(tree), [
    "Раздел",
    "  Подраздел",
    "Итог (02-09-2026)",
    "  Детали (02-09-2026)",
    "Ещё (03-09-2026)",
    "После блока",
    "Последний",
  ]);
});

test("buildOutlineTree without a block or records is a plain heading tree; date-only items have no suffix", () => {
  const plain = buildOutlineTree(
    [
      { text: "Заголовок", level: 1, line: 0 },
      { text: "Раздел", level: 2, line: 1 },
      { text: "Раздел", level: 2, line: 3 },
    ],
    null
  );
  assert.deepEqual(render(plain), ["Заголовок", "  Раздел", "  Раздел"]);
  // Одинаковые заголовки получают разные устойчивые id
  assert.notEqual(plain[0].children[0].id, plain[0].children[1].id);

  const emptyBlock = buildOutlineTree(TASK_HEADINGS, { line: 10, items: [] });
  assert.deepEqual(render(emptyBlock), ["Описание задачи", "Критерий выполнения", "Список подзадач"]);

  const dates = buildOutlineTree([], {
    line: 0,
    items: [tocItem("18-08-2026", "18-08-2026", { isDateOnly: true, subIndex: null })],
  });
  assert.deepEqual(render(dates), ["18-08-2026"]);
});

test("filterOutlineTree keeps matches with their parents; signature and collapsible ids", () => {
  const tree = buildOutlineTree(
    [
      { text: "Заголовок", level: 1, line: 0 },
      { text: "Раздел про кэш", level: 2, line: 1 },
      { text: "Другое", level: 2, line: 3 },
    ],
    { line: 5, items: [tocItem("Временный кэш", "01-09-2026"), tocItem("Образ", "18-08-2026", { subIndex: 1 })] }
  );
  assert.deepEqual(render(filterOutlineTree(tree, "кэш")), ["Заголовок", "  Раздел про кэш", "Временный кэш (01-09-2026)"]);
  assert.deepEqual(render(filterOutlineTree(tree, "18-08")), ["Образ (18-08-2026)"]);
  assert.deepEqual(filterOutlineTree(tree, "  "), tree);
  assert.deepEqual(collectCollapsibleIds(tree), [tree[0].id]);

  const same = buildOutlineTree(
    [
      { text: "Заголовок", level: 1, line: 0 },
      { text: "Раздел про кэш", level: 2, line: 1 },
      { text: "Другое", level: 2, line: 3 },
    ],
    { line: 5, items: [tocItem("Временный кэш", "01-09-2026"), tocItem("Образ", "18-08-2026", { subIndex: 1 })] }
  );
  assert.equal(outlineSignature(same), outlineSignature(tree));
  const moved = buildOutlineTree([{ text: "Заголовок", level: 1, line: 1 }], null);
  assert.notEqual(outlineSignature(moved), outlineSignature(buildOutlineTree([{ text: "Заголовок", level: 1, line: 0 }], null)));
});

const HOMEPAGE = [
  "---",
  "cssclasses:",
  "  - wide-page",
  "---",
  "",
  "```opa-reminders-view",
  "```",
  "",
  "```opa-projects-view",
  "```",
  "",
  "````markdown",
  "```opa-inbox-view",
  "```",
  "````",
  "",
  "## Прочее",
  "",
  "~~~opa-gamification-view",
  "~~~",
  "",
  "```opa-reminders-view",
  "```",
  "",
  "## Архив",
  "- [[Archive]]",
].join("\n");

test("findPluginBlocks lists plugin code blocks in order, skipping frontmatter and fenced examples", () => {
  assert.deepEqual(findPluginBlocks(HOMEPAGE), [
    { language: "opa-reminders-view", line: 5 },
    { language: "opa-projects-view", line: 8 },
    { language: "opa-gamification-view", line: 18 },
    { language: "opa-reminders-view", line: 21 },
  ]);
  assert.deepEqual(findPluginBlocks("```bash\necho\n```"), []);
});

test("buildOutlineTree puts block titles where the blocks are: top level before headings, inside a section after one", () => {
  const tree = buildOutlineTree(
    [
      { text: "Прочее", level: 2, line: 16 },
      { text: "Архив", level: 2, line: 24 },
    ],
    null,
    [
      { line: 5, title: "Напоминания", language: "opa-reminders-view", ordinal: 0 },
      { line: 8, title: "Проекты", language: "opa-projects-view", ordinal: 0 },
      { line: 18, title: "Прогресс", language: "opa-gamification-view", ordinal: 0 },
      { line: 21, title: "Напоминания", language: "opa-reminders-view", ordinal: 1 },
    ]
  );
  assert.deepEqual(render(tree), ["Напоминания", "Проекты", "Прочее", "  Прогресс", "  Напоминания", "Архив"]);
  assert.equal(tree[0].kind, "block");
  assert.deepEqual(tree[0].block, { language: "opa-reminders-view", ordinal: 0 });
  assert.equal(tree[0].line, 5);
  assert.deepEqual(tree[2].children[1].block, { language: "opa-reminders-view", ordinal: 1 });
  assert.notEqual(tree[0].id, tree[2].children[1].id);

  // Без заголовков заметки - всё на верхнем уровне
  const onlyBlocks = buildOutlineTree([], null, [{ line: 0, title: "Корзина", language: "opa-trash-view", ordinal: 0 }]);
  assert.deepEqual(render(onlyBlocks), ["Корзина"]);
});
