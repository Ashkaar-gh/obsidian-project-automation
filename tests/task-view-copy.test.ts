import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  alignBlocksToSource,
  buildCopyTextForBlock,
  buildCopyTextForRange,
  clipRangeToElement,
  coverageOfBlock,
  createStripState,
  embedMarkdown,
  fragmentToMarkdown,
  getRenderedBlocks,
  stripMarkdownLine,
} from "../src/core/TaskViewCopy";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const document = dom.window.document;

/** Отрисованный Obsidian'ом контент записи (структура повторяет вывод MarkdownRenderer.render). */
function renderDisplay(html: string): HTMLElement {
  const display = document.createElement("div");
  display.className = "markdown-preview-view markdown-rendered task-view-display";
  display.innerHTML = html;
  document.body.appendChild(display);
  return display;
}

/** Найти текстовый узел, содержащий фрагмент, и смещение фрагмента в нём. */
function locate(root: Node, text: string): { node: Text; offset: number } {
  const walker = document.createTreeWalker(root, dom.window.NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const idx = (node.nodeValue ?? "").indexOf(text);
    if (idx >= 0) return { node, offset: idx };
    node = walker.nextNode() as Text | null;
  }
  throw new Error(`text not found: ${text}`);
}

type Point = { text: string; at: "before" | "after" } | { node: Node; offset: number };

function makeRange(root: Node, start: Point, end: Point): Range {
  const range = document.createRange();
  const resolve = (p: Point): { node: Node; offset: number } => {
    if ("node" in p) return p;
    const { node, offset } = locate(root, p.text);
    return { node, offset: p.at === "before" ? offset : offset + p.text.length };
  };
  const s = resolve(start);
  const e = resolve(end);
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}

function selectWholeElement(el: Element): Range {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range;
}

const SOURCE = [
  "Сделал деплой [[Trino SA|SA]] и проверил",
  "```bash",
  "cd /opt",
  "htpasswd -nbB user pass >> file",
  "```",
  "Потом **важно**: `a*b*c`",
  "",
  "- [ ] пункт один",
  "- [x] пункт два",
  "    - вложенный",
  "",
  "### Подзаголовок",
  "Текст под заголовком",
  "",
  "![[img.png|300]]",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
].join("\n");

const RENDERED = `
<div class="el-p"><p>Сделал деплой <a class="internal-link" data-href="Trino SA" href="Trino SA">SA</a> и проверил</p></div>
<div class="el-pre"><pre class="language-bash"><code class="language-bash is-loaded">cd /opt
htpasswd -nbB user pass &gt;&gt; file
</code><button class="copy-code-button">Copy</button></pre></div>
<div class="el-p"><p>Потом <strong>важно</strong>: <code>a*b*c</code></p></div>
<div class="el-ul"><ul class="contains-task-list"><li class="task-list-item" data-task=" "><input type="checkbox">пункт один</li><li class="task-list-item is-checked" data-task="x"><input type="checkbox" checked="">пункт два<ul><li>вложенный</li></ul></li></ul></div>
<div class="el-h3"><h3 data-after-blank="0">Подзаголовок<div class="heading-collapse-indicator collapse-indicator collapse-icon"><svg></svg></div></h3></div>
<div class="el-p"><p>Текст под заголовком</p></div>
<div class="el-p"><p><span class="internal-embed image-embed is-loaded" src="img.png" alt="img.png|300"><img src="app://obsidian.md/img.png?123" alt="img.png|300" width="300"></span></p></div>
<div class="el-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>
`;

test("stripMarkdownLine approximates rendered text of a source line", () => {
  assert.equal(stripMarkdownLine("### Заголовок"), "Заголовок");
  assert.equal(stripMarkdownLine("- [ ] задача"), "задача");
  assert.equal(stripMarkdownLine("1. пункт"), "пункт");
  assert.equal(stripMarkdownLine("> цитата"), "цитата");
  assert.equal(stripMarkdownLine("> [!note] Заголовок"), "Заголовок");
  assert.equal(stripMarkdownLine("> [!warning]"), "Warning");
  assert.equal(stripMarkdownLine("см. [[Заметка|алиас]] и [[Другая#Раздел]]"), "см. алиас и Другая > Раздел");
  assert.equal(stripMarkdownLine("![[img.png|300]] ![alt](http://x/y.png)").trim(), "");
  assert.equal(stripMarkdownLine("**жирный** и *курсив* и ~~зачёркнуто~~ и ==выделено=="), "жирный и курсив и зачёркнуто и выделено");
  assert.equal(stripMarkdownLine("код `a*b*c` остаётся"), "код a*b*c остаётся");
  assert.equal(stripMarkdownLine("snake_case_name не курсив"), "snake_case_name не курсив");
  assert.equal(stripMarkdownLine("| a | b |"), "  a   b  ");
  assert.equal(stripMarkdownLine("|---|:---:|"), "");
  assert.equal(stripMarkdownLine("---"), "");
  assert.equal(stripMarkdownLine("[ссылка](http://example.com) и <https://a.b>"), "ссылка и https://a.b");
  assert.equal(stripMarkdownLine("экран \\*звёздочка\\* и &amp; &lt;"), "экран *звёздочка* и & <");
  assert.equal(stripMarkdownLine("текст <u>подчёркнут</u> ^block-id"), "текст подчёркнут");
});

test("stripMarkdownLine keeps code block content verbatim and treats fences as empty", () => {
  const state = createStripState();
  assert.equal(stripMarkdownLine("```bash", state), "");
  assert.equal(state.inFence, true);
  assert.equal(stripMarkdownLine("# not a heading", state), "# not a heading");
  assert.equal(stripMarkdownLine("- not a list", state), "- not a list");
  assert.equal(stripMarkdownLine("```", state), "");
  assert.equal(state.inFence, false);
  assert.equal(stripMarkdownLine("# heading", state), "heading");
});

test("alignBlocksToSource maps every rendered block to its source lines", () => {
  const display = renderDisplay(RENDERED);
  const blocks = getRenderedBlocks(display);
  assert.equal(blocks.length, 8);
  const mapping = alignBlocksToSource(blocks, SOURCE.split("\n"));
  assert.deepEqual(mapping, [
    { from: 0, to: 1 },
    { from: 1, to: 5 },
    { from: 5, to: 6 },
    { from: 7, to: 10 },
    { from: 11, to: 12 },
    { from: 12, to: 13 },
    { from: 14, to: 15 },
    { from: 16, to: 19 },
  ]);
  display.remove();
});

test("alignBlocksToSource survives an unmatched block in the middle (forward + backward passes)", () => {
  const source = ["Первый абзац", "", "$$x^2$$", "", "Третий абзац", "", "- пункт"].join("\n");
  const display = renderDisplay(`
    <div class="el-p"><p>Первый абзац</p></div>
    <div class="el-div"><div class="math math-block is-loaded"><mjx-container>x2</mjx-container></div></div>
    <div class="el-p"><p>Третий абзац</p></div>
    <div class="el-ul"><ul><li>пункт</li></ul></div>
  `);
  const mapping = alignBlocksToSource(getRenderedBlocks(display), source.split("\n"));
  assert.deepEqual(mapping, [{ from: 0, to: 1 }, null, { from: 4, to: 5 }, { from: 6, to: 7 }]);
  display.remove();
});

test("alignBlocksToSource refuses to map when rendered text differs from source", () => {
  const display = renderDisplay(`<div class="el-p"><p>Совсем другой текст</p></div>`);
  const mapping = alignBlocksToSource(getRenderedBlocks(display), ["Исходный текст"]);
  assert.deepEqual(mapping, [null]);
  display.remove();
});

test("whole blocks are copied verbatim from source (links, fences, indentation preserved)", () => {
  const display = renderDisplay(RENDERED);
  const blocks = getRenderedBlocks(display);
  const range = document.createRange();
  range.setStartBefore(blocks[0]);
  range.setEndAfter(blocks[1]);
  assert.equal(
    buildCopyTextForRange(range, display, SOURCE),
    ["Сделал деплой [[Trino SA|SA]] и проверил", "```bash", "cd /opt", "htpasswd -nbB user pass >> file", "```"].join("\n")
  );

  const listRange = selectWholeElement(blocks[3]);
  assert.equal(buildCopyTextForRange(listRange, display, SOURCE), "- [ ] пункт один\n- [x] пункт два\n    - вложенный");

  const headingAndText = document.createRange();
  headingAndText.setStartBefore(blocks[4]);
  headingAndText.setEndAfter(blocks[5]);
  assert.equal(buildCopyTextForRange(headingAndText, display, SOURCE), "### Подзаголовок\nТекст под заголовком");

  assert.equal(buildCopyTextForRange(selectWholeElement(blocks[6]), display, SOURCE), "![[img.png|300]]");
  assert.equal(buildCopyTextForRange(selectWholeElement(blocks[7]), display, SOURCE), "| a | b |\n|---|---|\n| 1 | 2 |");
  display.remove();
});

test("selection that covers all visible text of a block counts as the whole block", () => {
  const display = renderDisplay(RENDERED);
  const blocks = getRenderedBlocks(display);
  const range = makeRange(display, { text: "Сделал", at: "before" }, { text: "проверил", at: "after" });
  assert.deepEqual(coverageOfBlock(range, blocks[0]), { startFull: true, endFull: true });
  assert.equal(buildCopyTextForRange(range, display, SOURCE), "Сделал деплой [[Trino SA|SA]] и проверил");

  const codeRange = makeRange(display, { text: "cd /opt", at: "before" }, { text: ">> file", at: "after" });
  assert.equal(buildCopyTextForRange(codeRange, display, SOURCE), "```bash\ncd /opt\nhtpasswd -nbB user pass >> file\n```");
  display.remove();
});

test("partial selections are serialized from DOM without escaping and without fences", () => {
  const display = renderDisplay(RENDERED);
  const partialParagraph = makeRange(display, { text: "деплой", at: "before" }, { text: " и", at: "after" });
  assert.equal(buildCopyTextForRange(partialParagraph, display, SOURCE), "деплой [[Trino SA|SA]] и");

  const partialCode = makeRange(display, { text: "htpasswd", at: "before" }, { text: "user pass", at: "after" });
  assert.equal(buildCopyTextForRange(partialCode, display, SOURCE), "htpasswd -nbB user pass");

  const fromParagraphIntoCode = makeRange(display, { text: "деплой", at: "before" }, { text: "cd /opt", at: "after" });
  assert.equal(buildCopyTextForRange(fromParagraphIntoCode, display, SOURCE), "деплой [[Trino SA|SA]] и проверил\n\ncd /opt");

  const fromCodeIntoParagraph = makeRange(display, { text: ">> file", at: "before" }, { text: "важно", at: "after" });
  assert.equal(buildCopyTextForRange(fromCodeIntoParagraph, display, SOURCE), ">> file\n\nПотом **важно**");

  const inlineCode = makeRange(display, { text: "Потом", at: "before" }, { text: "a*b*c", at: "after" });
  assert.equal(buildCopyTextForRange(inlineCode, display, SOURCE), "Потом **важно**: `a*b*c`");
  display.remove();
});

test("mixed selection: partial first block + whole following blocks keeps source spacing", () => {
  const display = renderDisplay(RENDERED);
  const range = makeRange(display, { text: "важно", at: "before" }, { text: "вложенный", at: "after" });
  assert.equal(
    buildCopyTextForRange(range, display, SOURCE),
    "**важно**: `a*b*c`\n\n- [ ] пункт один\n- [x] пункт два\n    - вложенный"
  );
  display.remove();
});

test("heading directly followed by a paragraph: partial selection does not insert a blank line", () => {
  const display = renderDisplay(RENDERED);
  // В исходнике «### Подзаголовок» и «Текст под заголовком» - соседние строки без пустой между ними
  const headingAndPartOfText = makeRange(display, { text: "Подзаголовок", at: "before" }, { text: "Текст под", at: "after" });
  assert.equal(buildCopyTextForRange(headingAndPartOfText, display, SOURCE), "### Подзаголовок\nТекст под");

  // Выделение начинается внутри заголовка: структура сохраняется (маркер заголовка), пустой строки по-прежнему нет
  const tailOfHeadingAndText = makeRange(display, { text: "заголовок", at: "before" }, { text: "заголовком", at: "after" });
  assert.equal(buildCopyTextForRange(tailOfHeadingAndText, display, SOURCE), "### заголовок\nТекст под заголовком");

  // Без исходника ориентир - разметка блока (data-after-blank="0" у заголовка)
  assert.equal(buildCopyTextForRange(headingAndPartOfText, display, ""), "### Подзаголовок\nТекст под");

  // Между абзацем и списком в исходнике пустая строка - она сохраняется
  const textAndImage = makeRange(display, { text: "a*b*c", at: "before" }, { text: "пункт один", at: "after" });
  assert.equal(buildCopyTextForRange(textAndImage, display, SOURCE), "`a*b*c`\n\n- [ ] пункт один");
  display.remove();
});

test("without a source the copy falls back to DOM serialization", () => {
  const display = renderDisplay(RENDERED);
  const blocks = getRenderedBlocks(display);
  const range = document.createRange();
  range.setStartBefore(blocks[0]);
  range.setEndAfter(blocks[3]);
  assert.equal(
    buildCopyTextForRange(range, display, ""),
    [
      "Сделал деплой [[Trino SA|SA]] и проверил",
      "",
      "```bash",
      "cd /opt",
      "htpasswd -nbB user pass >> file",
      "```",
      "",
      "Потом **важно**: `a*b*c`",
      "",
      "- [ ] пункт один",
      "- [x] пункт два",
      "    - вложенный",
    ].join("\n")
  );
  display.remove();
});

test("buildCopyTextForBlock copies the block under the cursor", () => {
  const display = renderDisplay(RENDERED);
  const blocks = getRenderedBlocks(display);
  assert.equal(buildCopyTextForBlock(blocks[1], display, SOURCE), "```bash\ncd /opt\nhtpasswd -nbB user pass >> file\n```");
  assert.equal(buildCopyTextForBlock(blocks[7], display, ""), "| a | b |\n| --- | --- |\n| 1 | 2 |");
  display.remove();
});

test("fragmentToMarkdown drops UI chrome and does not escape markdown characters", () => {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <details class="task-view-entry"><summary class="task-view-summary"><div class="task-view-summary-title"><p><strong><a class="internal-link" data-href="periodic/daily/01-09-2026.md#Task">01-09-2026</a></strong></p></div><div class="task-view-summary-actions"><button>▼</button></div></summary>
    <div class="markdown-embed-content"><div class="task-view-display">
      <div class="el-p"><p>snake_case_name * 2 [x] #tag <mark>важно</mark> <a class="external-link" href="https://example.com">пример</a>\u200B</p></div>
      <div class="el-blockquote"><blockquote><p>цитата</p></blockquote></div>
      <div class="el-div"><div class="callout" data-callout="warning" data-callout-fold="-"><div class="callout-title"><div class="callout-icon"><svg></svg></div><div class="callout-title-inner">Осторожно</div><div class="callout-fold"><svg></svg></div></div><div class="callout-content"><p>текст callout</p></div></div></div>
      <div class="el-ol"><ol start="3"><li>третий</li><li>четвёртый<br>вторая строка</li></ol></div>
    </div></div>
    <div class="task-view-edit-wrap"><textarea class="task-view-edit">raw markdown</textarea><button class="task-view-save-button">Сохранить</button></div></details>
  `;
  const md = fragmentToMarkdown(wrapper);
  assert.equal(
    md,
    [
      "snake_case_name * 2 [x] #tag ==важно== [пример](https://example.com)",
      "",
      "> цитата",
      "",
      "> [!warning]- Осторожно",
      "> текст callout",
      "",
      "3. третий",
      "4. четвёртый",
      "   вторая строка",
    ].join("\n")
  );
  assert.ok(!md.includes("Сохранить"));
  assert.ok(!md.includes("▼"));
  assert.ok(!md.includes("raw markdown"));
  assert.ok(!md.includes("01-09-2026"));
});

test("embedMarkdown restores image embeds with size from alt or width", () => {
  const make = (attrs: string, imgAttrs: string): Element => {
    const holder = document.createElement("div");
    holder.innerHTML = `<span class="internal-embed image-embed" ${attrs}><img ${imgAttrs}></span>`;
    return holder.firstElementChild!;
  };
  assert.equal(embedMarkdown(make('src="img.png" alt="img.png|300"', 'src="app://x/img.png" width="300"')), "![[img.png|300]]");
  assert.equal(embedMarkdown(make('src="img.png" alt="300"', 'src="app://x/img.png" width="300"')), "![[img.png|300]]");
  assert.equal(embedMarkdown(make('src="img.png" alt="img.png"', 'src="app://x/img.png" width="400"')), "![[img.png|400]]");
  assert.equal(embedMarkdown(make('src="img.png" alt="img.png"', 'src="app://x/img.png"')), "![[img.png]]");
  assert.equal(embedMarkdown(make('src="Заметка"', "")), "![[Заметка]]");
});

test("clipRangeToElement returns null when the range does not touch the element content", () => {
  const display = renderDisplay(RENDERED);
  const blocks = getRenderedBlocks(display);
  const range = selectWholeElement(blocks[0]);
  assert.equal(clipRangeToElement(range, blocks[2]), null);
  const clipped = clipRangeToElement(range, blocks[0]);
  assert.ok(clipped && !clipped.collapsed);
  display.remove();
});

test("images without text stay with the paragraph they belong to (no bleed into the next block)", () => {
  // Текст + картинка в одном абзаце, затем абзац из одной картинки
  const source = ["Текст", "![[a.png]]", "", "![[b.png]]"].join("\n");
  const display = renderDisplay(`
    <div class="el-p"><p>Текст<br><span class="internal-embed image-embed" src="a.png" alt="a.png"><img src="app://x/a.png"></span></p></div>
    <div class="el-p"><p><span class="internal-embed image-embed" src="b.png" alt="b.png"><img src="app://x/b.png"></span></p></div>
  `);
  const blocks = getRenderedBlocks(display);
  assert.deepEqual(alignBlocksToSource(blocks, source.split("\n")), [{ from: 0, to: 2 }, { from: 3, to: 4 }]);
  assert.equal(buildCopyTextForBlock(blocks[0], display, source), "Текст\n![[a.png]]");
  assert.equal(buildCopyTextForBlock(blocks[1], display, source), "![[b.png]]");
  display.remove();

  // Картинка, за которой идёт обычный абзац: картинка не «уходит» в него
  const source2 = ["Смотри скрин:", "![[shot.png]] ![[shot2.png]]", "", "Далее текст"].join("\n");
  const display2 = renderDisplay(`
    <div class="el-p"><p>Смотри скрин:<br><span class="internal-embed image-embed" src="shot.png" alt="shot.png"><img></span> <span class="internal-embed image-embed" src="shot2.png" alt="shot2.png"><img></span></p></div>
    <div class="el-p"><p>Далее текст</p></div>
  `);
  const blocks2 = getRenderedBlocks(display2);
  assert.deepEqual(alignBlocksToSource(blocks2, source2.split("\n")), [{ from: 0, to: 2 }, { from: 3, to: 4 }]);
  assert.equal(buildCopyTextForBlock(blocks2[1], display2, source2), "Далее текст");
  display2.remove();

  // Обратный проход: абзац, начинающийся с картинки, после несопоставимого блока
  const source3 = ["$$x$$", "", "![[img.png]]", "Подпись", "", "Текст"].join("\n");
  const display3 = renderDisplay(`
    <div class="el-div"><div class="math math-block"><mjx-container>x</mjx-container></div></div>
    <div class="el-p"><p><span class="internal-embed image-embed" src="img.png" alt="img.png"><img></span><br>Подпись</p></div>
    <div class="el-p"><p>Текст</p></div>
  `);
  const blocks3 = getRenderedBlocks(display3);
  assert.deepEqual(alignBlocksToSource(blocks3, source3.split("\n")), [null, { from: 2, to: 4 }, { from: 5, to: 6 }]);
  assert.equal(buildCopyTextForBlock(blocks3[1], display3, source3), "![[img.png]]\nПодпись");
  display3.remove();
});

test("ATX heading followed by a thematic break is not treated as a setext underline", () => {
  const source = ["### Заголовок", "---", "Текст"].join("\n");
  const display = renderDisplay(`
    <div class="el-h3"><h3>Заголовок</h3></div>
    <div class="el-hr"><hr></div>
    <div class="el-p"><p>Текст</p></div>
  `);
  const blocks = getRenderedBlocks(display);
  assert.deepEqual(alignBlocksToSource(blocks, source.split("\n")), [{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }]);
  const all = document.createRange();
  all.selectNodeContents(display);
  assert.equal(buildCopyTextForRange(all, display, source), "### Заголовок\n---\nТекст");
  display.remove();

  const setext = renderDisplay(`<div class="el-h2"><h2>Заголовок</h2></div><div class="el-p"><p>Текст</p></div>`);
  assert.deepEqual(alignBlocksToSource(getRenderedBlocks(setext), ["Заголовок", "---", "Текст"]), [{ from: 0, to: 2 }, { from: 2, to: 3 }]);
  setext.remove();
});

test("partial selection inside one code block keeps line structure (Prism spans, no fences)", () => {
  const source = ["```python", "def f():", "    return 1", "print(f())", "```"].join("\n");
  const display = renderDisplay(`
    <div class="el-pre"><pre class="language-python"><code class="language-python"><span class="token keyword">def</span> <span class="token function">f</span><span class="token punctuation">():</span>
    <span class="token keyword">return</span> <span class="token number">1</span>
<span class="token builtin">print</span><span class="token punctuation">(</span>f<span class="token punctuation">())</span>
</code><button class="copy-code-button">Copy</button></pre></div>
  `);
  const range = makeRange(display, { text: "def", at: "before" }, { text: "1", at: "after" });
  assert.equal(buildCopyTextForRange(range, display, source), "def f():\n    return 1");
  // без исходника - тот же результат из DOM
  assert.equal(buildCopyTextForRange(range, display, ""), "def f():\n    return 1");
  display.remove();
});

test("partial selections in lists and tables: whole items keep markers, text inside one item/cell is plain", () => {
  const display = renderDisplay(`
    <div class="el-ol"><ol start="5"><li>пятый пункт</li><li>шестой пункт</li><li>седьмой</li></ol></div>
    <div class="el-table"><table><thead><tr><th>Имя</th><th>Значение</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table></div>
  `);
  const twoItems = makeRange(display, { text: "пункт", at: "before" }, { text: "шестой пункт", at: "after" });
  assert.equal(buildCopyTextForRange(twoItems, display, ""), "5. пункт\n6. шестой пункт");
  const insideItem = makeRange(display, { text: "шестой", at: "before" }, { text: "шестой", at: "after" });
  assert.equal(buildCopyTextForRange(insideItem, display, ""), "шестой");
  const insideCell = makeRange(display, { text: "Значение", at: "before" }, { text: "Значение", at: "after" });
  assert.equal(buildCopyTextForRange(insideCell, display, ""), "Значение");
  const rows = makeRange(display, { text: "a", at: "before" }, { text: "2", at: "after" });
  assert.equal(buildCopyTextForRange(rows, display, ""), "| a | 1 |\n| --- | --- |\n| b | 2 |");
  display.remove();
});

test("backward pass handles fences with an info string and comments separated by blank lines", () => {
  const source = ["%% скрытый %%", "", "Абзац", "", "$$x^2$$", "", "```bash", "echo hi", "```", "", "Хвост"].join("\n");
  const display = renderDisplay(`
    <div class="el-p"><p>Абзац</p></div>
    <div class="el-div"><div class="math math-block"><mjx-container>x2</mjx-container></div></div>
    <div class="el-pre"><pre class="language-bash"><code>echo hi
</code></pre></div>
    <div class="el-p"><p>Хвост</p></div>
  `);
  const blocks = getRenderedBlocks(display);
  assert.deepEqual(alignBlocksToSource(blocks, source.split("\n")), [
    { from: 2, to: 3 },
    null,
    { from: 6, to: 9 },
    { from: 10, to: 11 },
  ]);
  assert.equal(buildCopyTextForBlock(blocks[0], display, source), "Абзац");
  assert.equal(buildCopyTextForBlock(blocks[2], display, source), "```bash\necho hi\n```");
  display.remove();
});
