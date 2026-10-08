import assert from "node:assert/strict";
import test from "node:test";
import {
  appendHeadingBlockToDaily,
  buildDailyHeadingBlock,
  markdownHeadings,
  wikiLinkTargets,
  isDailyNavLine,
  newDailyNoteCursor,
  replaceLineWithHeadingBlock,
  sectionCursorPosition,
  taskNameFromEditorLine,
} from "../src/core/DailyNoteEdit";

test("task name from an editor line drops markers, links and forbidden characters", () => {
  assert.equal(taskNameFromEditorLine("Выдать доступ в trino для аналитиков"), "Выдать доступ в trino для аналитиков");
  assert.equal(taskNameFromEditorLine("- [ ] Выдать доступ"), "Выдать доступ");
  assert.equal(taskNameFromEditorLine("  * [x]  Сделано  "), "Сделано");
  assert.equal(taskNameFromEditorLine("3. Третий пункт"), "Третий пункт");
  assert.equal(taskNameFromEditorLine("### [[Уже задача|алиас]]"), "Уже задача");
  assert.equal(taskNameFromEditorLine("[[Проекты/Trino#Раздел]]"), "Проекты/Trino".replace("/", ""));
  assert.equal(taskNameFromEditorLine("> **Срочно: починить**"), "Срочно починить");
  assert.equal(taskNameFromEditorLine('Имя с / \\ : * ? " < > | # ^ [ ] символами'), "Имя с символами");
  // Только первая строка выделения
  assert.equal(taskNameFromEditorLine("Первая\nВторая"), "Первая");
  assert.equal(taskNameFromEditorLine("   "), "");
});

test("daily heading block ends with a newline", () => {
  assert.equal(buildDailyHeadingBlock("Задача"), "### [[Задача]]\n");
});

test("replacing the source line keeps the rest of the daily note intact", () => {
  const content = ["← [[a|a]] | [[b|b]] →", "", "Утро", "Выдать доступ", "Вечер"].join("\n");
  const block = buildDailyHeadingBlock("Выдать доступ");
  assert.equal(
    replaceLineWithHeadingBlock(content, 3, "Выдать доступ", block),
    ["← [[a|a]] | [[b|b]] →", "", "Утро", "### [[Выдать доступ]]", "Вечер"].join("\n")
  );
  // Индекс сдвинулся (строка добавлена выше) - строка находится по тексту
  const shifted = ["Новая строка", ...content.split("\n")].join("\n");
  assert.match(replaceLineWithHeadingBlock(shifted, 3, "  Выдать доступ ", block) ?? "", /Утро\n### \[\[Выдать доступ\]\]\nВечер/);
  // CR в конце строки не мешает
  assert.equal(replaceLineWithHeadingBlock("a\r\nИмя\r\nb", 1, "Имя", buildDailyHeadingBlock("Имя")), "a\r\n### [[Имя]]\nb");
  // Строка исчезла или пустая - замены нет
  assert.equal(replaceLineWithHeadingBlock(content, 3, "Другой текст", block), null);
  assert.equal(replaceLineWithHeadingBlock(content, 3, "   ", block), null);
});

test("appending a heading block to a daily note separates it from existing text", () => {
  const block = "### [[Задача]]\n";
  assert.equal(appendHeadingBlockToDaily("", block), block);
  assert.equal(appendHeadingBlockToDaily("← [[a|a]] | [[b|b]] →", block), "← [[a|a]] | [[b|b]] →\n### [[Задача]]\n");
  assert.equal(appendHeadingBlockToDaily("текст", block), "текст\n\n### [[Задача]]\n");
  assert.equal(appendHeadingBlockToDaily("текст\n", block), "текст\n\n### [[Задача]]\n");
  assert.equal(appendHeadingBlockToDaily("текст\n\n", block), "текст\n\n### [[Задача]]\n");
});

test("cursor in a new daily note lands right under the navigation line", () => {
  const nav = "← [[periodic/daily/16-09-2026.md|16-09-2026]]  |  [[periodic/daily/18-09-2026.md|18-09-2026]] →";
  assert.equal(isDailyNavLine(nav), true);
  assert.equal(isDailyNavLine("## Заметки"), false);
  // Шаблон по умолчанию: навигация и перевод строки - курсор на пустую вторую строку
  assert.deepEqual(newDailyNoteCursor([nav, ""]), { line: 1, ch: 0, insertNewline: false });
  // Свой шаблон: между навигацией и заголовком есть пустая строка - курсор на неё
  assert.deepEqual(newDailyNoteCursor([nav, "", "## Заметки", ""]), { line: 1, ch: 0, insertNewline: false });
  // Навигация без перевода строки в конце файла - строку под ней нужно добавить
  assert.deepEqual(newDailyNoteCursor([nav]), { line: 1, ch: 0, insertNewline: true });
  // Шаблон без навигации - курсор в начале, как раньше
  assert.deepEqual(newDailyNoteCursor(["## Заметки", ""]), { line: 0, ch: 0, insertNewline: false });
  assert.deepEqual(newDailyNoteCursor([""]), { line: 0, ch: 0, insertNewline: false });
});

test("cursor for continuing a task entry: end of the last line, or right under an empty heading", () => {
  const lines = ["← a | b →", "", "### [[Первая]]", "текст", "ещё текст", "", "### [[Вторая]]", "", "## Итоги", "х"];
  // Непустая секция: конец последней непустой строки (пустая перед следующим заголовком пропускается)
  assert.deepEqual(sectionCursorPosition(lines, 2), { line: 4, ch: "ещё текст".length, insertNewline: false });
  // Пустая секция с пустой строкой под заголовком: на эту строку (## выше уровнем закрывает секцию)
  assert.deepEqual(sectionCursorPosition(lines, 6), { line: 7, ch: 0, insertNewline: false });
  // Заголовок - последняя строка файла без перевода строки: строку нужно добавить
  assert.deepEqual(sectionCursorPosition(["текст", "### [[Задача]]"], 1), { line: 2, ch: 0, insertNewline: true });
  // Следующий заголовок сразу под заголовком задачи: тоже нужна новая строка
  assert.deepEqual(sectionCursorPosition(["### [[A]]", "### [[B]]"], 0), { line: 1, ch: 0, insertNewline: true });
  // Файл с завершающим переводом строки даёт пустой последний элемент - курсор на нём
  assert.deepEqual(sectionCursorPosition("### [[A]]\n".split("\n"), 0), { line: 1, ch: 0, insertNewline: false });
  // Подзаголовки внутри секции (уровнем ниже) секцию не закрывают
  assert.deepEqual(sectionCursorPosition(["### [[A]]", "#### шаг 1", "сделано", ""], 0), { line: 2, ch: "сделано".length, insertNewline: false });
});

test("headings: code blocks and frontmatter are not split into sections", () => {
  const lines = ["---", "# yaml comment", "---", "# Заголовок #", "```", "# не заголовок", "```", "~~~~", "## тоже нет", "~~~~", "##без пробела", "### [[Задача]]", "#"];
  assert.deepEqual(markdownHeadings(lines), [
    { line: 3, level: 1, text: "Заголовок" },
    { line: 11, level: 3, text: "[[Задача]]" },
    { line: 12, level: 1, text: "" },
  ]);
  assert.deepEqual(wikiLinkTargets("[[Папка/Задача|алиас]] и [[Другая#Раздел]]"), ["Папка/Задача", "Другая"]);
});
