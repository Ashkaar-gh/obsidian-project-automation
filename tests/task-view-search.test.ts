import assert from "node:assert/strict";
import test from "node:test";
import {
  MergedSearchCursor,
  findCodeBlockRanges,
  findTextMatches,
  foldForSearch,
  mergeSearchMatches,
  type MergedCursorHost,
  type SearchBlockSource,
} from "../src/core/TaskViewSearch";

test("foldForSearch lowercases without changing length and treats NBSP as a space", () => {
  assert.equal(foldForSearch("Синкаем С РЕПО"), "синкаем с репо");
  assert.equal(foldForSearch("a b"), "a b");
  // İ в нижнем регистре длиннее - остаётся как есть, позиции не сдвигаются
  const folded = foldForSearch("İstanbul Синк");
  assert.equal(folded.length, "İstanbul Синк".length);
  assert.ok(folded.endsWith("синк"));
});

test("findTextMatches finds case-insensitive non-overlapping matches", () => {
  assert.deepEqual(findTextMatches("Синкаем, синк и СИНК", "синк"), [
    { from: 0, to: 4 },
    { from: 9, to: 13 },
    { from: 16, to: 20 },
  ]);
  assert.deepEqual(findTextMatches("aaaa", "aa"), [
    { from: 0, to: 2 },
    { from: 2, to: 4 },
  ]);
  assert.deepEqual(findTextMatches("text", ""), []);
});

const TASK_NOTE = [
  "---",
  "status: В работе",
  "---",
  "## Описание задачи",
  "Синкаем конфиг",
  "",
  "```bash",
  "```opa-task-view",
  "```",
  "",
  "```opa-task-view",
  "```",
  "",
  "Хвост заметки: синк",
].join("\n");

test("findCodeBlockRanges finds task-view blocks outside frontmatter and other fences", () => {
  const blocks = findCodeBlockRanges(TASK_NOTE, "opa-task-view");
  assert.equal(blocks.length, 1);
  const [block] = blocks;
  assert.equal(block.lineStart, 10);
  assert.equal(block.lineEnd, 11);
  assert.equal(TASK_NOTE.slice(block.from, block.to), "```opa-task-view\n```");

  const crlf = TASK_NOTE.replace(/\n/g, "\r\n");
  const [crlfBlock] = findCodeBlockRanges(crlf, "opa-task-view");
  assert.equal(crlf.slice(crlfBlock.from, crlfBlock.to), "```opa-task-view\r\n```");

  assert.deepEqual(findCodeBlockRanges("~~~OPA-TASK-VIEW\n~~~", "opa-task-view"), [
    { from: 0, to: 20, lineStart: 0, lineEnd: 1 },
  ]);
  // Незакрытый блок - до конца заметки, как его показывает Obsidian
  assert.deepEqual(findCodeBlockRanges("text\n```opa-task-view\nmore", "opa-task-view"), [
    { from: 5, to: 26, lineStart: 1, lineEnd: 2 },
  ]);
  assert.deepEqual(findCodeBlockRanges("```bash\necho\n```", "opa-task-view"), []);
});

/** Блок с «находками» - строками (в модуле это диапазоны DOM). */
function block(from: number, to: number, hits: string[], rendered = true): SearchBlockSource<string> {
  return {
    from,
    to,
    rendered,
    find: (query) => hits.filter((hit) => hit.toLowerCase().includes(query.toLowerCase())),
  };
}

const NOTE = "синк раз\n```opa-task-view\nсинк\n```\nсинк два";
const FENCE = findCodeBlockRanges(NOTE, "opa-task-view")[0];

test("mergeSearchMatches puts block hits at the block position and hides the rendered block's markdown", () => {
  const matches = mergeSearchMatches(NOTE, "синк", [block(FENCE.from, FENCE.to, ["синк-1", "Синк-2"])]);
  assert.deepEqual(
    matches.map((m) => (m.kind === "doc" ? `doc@${m.from}` : `block#${m.ordinal}:${m.hit}`)),
    ["doc@0", "block#0:синк-1", "block#1:Синк-2", `doc@${NOTE.lastIndexOf("синк")}`]
  );

  // Курсор внутри блока: Obsidian показывает markdown блока - он ищется как текст заметки
  const source = mergeSearchMatches(NOTE, "синк", [block(FENCE.from, FENCE.to, ["синк-1"], false)]);
  assert.deepEqual(
    source.map((m) => m.kind),
    ["doc", "doc", "doc"]
  );
  assert.deepEqual(mergeSearchMatches(NOTE, "", [block(FENCE.from, FENCE.to, ["синк"])]), []);
});

interface Recorded {
  replaced: { text: string; from: number; to: number }[];
  batches: { from: number; to: number; text: string }[][];
  skipped: number[];
}

function makeHost(state: { text: string; selection: { from: number; to: number }; hits: string[] }) {
  const recorded: Recorded = { replaced: [], batches: [], skipped: [] };
  const host: MergedCursorHost<string, string> = {
    getText: () => state.text,
    getSelection: () => state.selection,
    getBlocks: (text) => {
      const fence = findCodeBlockRanges(text, "opa-task-view")[0];
      return fence ? [block(fence.from, fence.to, state.hits)] : [];
    },
    docResult: (from, to) => `doc:${state.text.slice(from, to)}@${from}`,
    blockResult: (match) => `block:${match.hit}`,
    replaceRange: (text, from, to) => {
      recorded.replaced.push({ text, from, to });
      state.text = state.text.slice(0, from) + text + state.text.slice(to);
    },
    replaceRanges: (changes) => {
      recorded.batches.push(changes);
    },
    onBlockReplaceSkipped: (count) => recorded.skipped.push(count),
  };
  return { host, recorded };
}

test("MergedSearchCursor walks note text and block hits in note order, starting after the selection", () => {
  const state = { text: NOTE, selection: { from: 0, to: 0 }, hits: ["синк-1", "синк-2"] };
  const { host } = makeHost(state);
  const cursor = new MergedSearchCursor(host, "синк");
  assert.deepEqual(cursor.getIndexAndCount(), [0, 0]);
  assert.equal(cursor.findNext(), "doc:синк@0");
  assert.deepEqual(cursor.getIndexAndCount(), [1, 4]);
  assert.equal(cursor.findNext(), "block:синк-1");
  assert.equal(cursor.current(), null, "a block hit has no place in the note text");
  assert.equal(cursor.findNext(), "block:синк-2");
  assert.deepEqual(cursor.getIndexAndCount(), [3, 4]);
  assert.match(String(cursor.findNext()), /^doc:синк@\d+$/);
  assert.match(String(cursor.current()), /^doc:синк@/);
  assert.equal(cursor.findNext(), "doc:синк@0", "wraps around like the editor search");
  assert.equal(cursor.findPrevious(), `doc:синк@${NOTE.lastIndexOf("синк")}`);
  assert.equal(cursor.findPrevious(), "block:синк-2");

  // Выделение после блока - первое совпадение после него
  const after = new MergedSearchCursor(makeHost({ ...state, selection: { from: FENCE.to + 1, to: FENCE.to + 1 } }).host, "синк");
  assert.match(String(after.findNext()), /^doc:синк@\d+$/);
  assert.deepEqual(after.getIndexAndCount(), [4, 4]);

  // Назад от выделения в конце первой строки: последнее совпадение, закончившееся до него
  const back = new MergedSearchCursor(makeHost({ ...state, selection: { from: 8, to: 8 } }).host, "синк");
  assert.equal(back.findPrevious(), "doc:синк@0");
  assert.equal(back.findPrevious(), `doc:синк@${NOTE.lastIndexOf("синк")}`);
});

test("MergedSearchCursor recomputes matches: a vanished hit continues from its place", () => {
  const state = { text: NOTE, selection: { from: 0, to: 0 }, hits: ["синк-1", "синк-2", "синк-3"] };
  const cursor = new MergedSearchCursor(makeHost(state).host, "синк");
  cursor.findNext();
  assert.equal(cursor.findNext(), "block:синк-1");
  assert.equal(cursor.findNext(), "block:синк-2");
  // Блок перерисовался: совпадений стало меньше
  state.hits = ["синк-1"];
  assert.deepEqual(cursor.getIndexAndCount(), [2, 3]);
  assert.match(String(cursor.findNext()), /^doc:синк@\d+$/);
  state.hits = [];
  assert.equal(cursor.findNext(), "doc:синк@0");
  state.text = "ничего";
  assert.equal(cursor.findNext(), null);
  assert.deepEqual(cursor.getIndexAndCount(), [0, 0]);
});

test("MergedSearchCursor replaces only note text and reports skipped entries", () => {
  const state = { text: NOTE, selection: { from: 0, to: 0 }, hits: ["синк-1"] };
  const { host, recorded } = makeHost(state);
  const cursor = new MergedSearchCursor(host, "синк");
  cursor.findNext();
  cursor.replace("sync");
  assert.deepEqual(recorded.replaced, [{ text: "sync", from: 0, to: 4 }]);
  assert.ok(state.text.startsWith("sync раз"));
  assert.equal(cursor.findNext(), "block:синк-1", "continues after the inserted text");
  cursor.replace("sync");
  assert.deepEqual(recorded.skipped, [1]);
  assert.equal(recorded.replaced.length, 1);

  cursor.replaceAll("sync");
  const tailFrom = state.text.lastIndexOf("синк");
  assert.deepEqual(recorded.batches, [[{ from: tailFrom, to: tailFrom + 4, text: "sync" }]]);
  assert.deepEqual(recorded.skipped, [1, 1]);
});
