import assert from "node:assert/strict";
import test from "node:test";
import { TFile, createMockApp } from "obsidian";
import {
  findSectionBounds,
  findUniqueLineIndexByText,
  processSectionByHeading,
  replaceSectionByHeading,
  toggleTaskCheckbox,
  updateFrontmatter,
} from "../src/core/FileIO";

test("FileIO finds section boundaries without consuming sibling sections", () => {
  const lines = ["# Note", "## Target", "body", "### Child", "details", "## Next", "other"];
  assert.deepEqual(findSectionBounds(lines, "## Target"), { startIdx: 1, endIdx: 5 });
  assert.equal(findSectionBounds(lines, "## Missing"), null);
});

test("FileIO line lookup prefers the exact line and accepts a fuzzy match only when unique", () => {
  assert.equal(findUniqueLineIndexByText(["alpha", "beta"], "bet"), 1);
  assert.equal(findUniqueLineIndexByText(["alpha one", "alpha two"], "alpha"), -1);
  // Точное совпадение важнее нечёткого, пробелы нормализуются, берётся первая строка текста
  assert.equal(findUniqueLineIndexByText(["- [ ]  Task  one", "- [ ] Task"], " - [ ] Task \nвторая строка"), 1);
  assert.equal(findUniqueLineIndexByText(["a", "b"], "   "), -1);
});

test("FileIO checkbox helper supports bullets, indentation and both directions", () => {
  assert.equal(toggleTaskCheckbox("  * [ ] Work", true), "  * [x] Work");
  assert.equal(toggleTaskCheckbox("- [X] Done", false), "- [ ] Done");
  assert.equal(toggleTaskCheckbox("plain", true), "plain");
});

test("FileIO reports failed section writes and updates frontmatter", async () => {
  const mock = createMockApp({ "Task.md": "## Target\nold" });
  const file = mock.files.get("Task.md") as TFile;
  mock.vault.process = async () => { throw new Error("disk failure"); };
  assert.equal(await processSectionByHeading(mock.app, file, "## Target", () => "new"), false);

  await updateFrontmatter(mock.app, file.path, "status", "Готово");
  assert.deepEqual(mock.frontmatters.get(file.path), { status: "Готово" });
});

test("replaceSectionByHeading keeps the blank lines that separate the section from the next heading", async () => {
  const mock = createMockApp({
    "daily.md": ["# Day", "", "### [[Task]]", "old body", "", "### [[Other]]", "text"].join("\n"),
  });
  const file = mock.files.get("daily.md") as TFile;
  assert.equal(await replaceSectionByHeading(mock.app, file, "### [[Task]]", "new body\nsecond line\n\n"), true);
  assert.equal(
    mock.contents.get("daily.md"),
    ["# Day", "", "### [[Task]]", "new body", "second line", "", "### [[Other]]", "text"].join("\n")
  );
  // Секция в конце файла без пустых строк - ничего лишнего не добавляем
  const tail = createMockApp({ "tail.md": ["### [[Task]]", "old"].join("\n") });
  const tailFile = tail.files.get("tail.md") as TFile;
  await replaceSectionByHeading(tail.app, tailFile, "### [[Task]]", "new");
  assert.equal(tail.contents.get("tail.md"), ["### [[Task]]", "new", ""].join("\n"));
});
