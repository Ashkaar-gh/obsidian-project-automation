import assert from "node:assert/strict";
import test from "node:test";
import { parseOpaPrompt } from "../src/core/TaskTemplatePrompts";

test("opa_prompts: a prompt is required only with an explicit required: true", () => {
  // Поля шаблона обычно заполняются позже, поэтому без флага поле необязательно
  assert.deepEqual(parseOpaPrompt({ key: "account_name", label: "Имя УЗ" }), {
    key: "account_name",
    label: "Имя УЗ",
    type: "text",
  });
  assert.deepEqual(parseOpaPrompt({ key: "account_name", label: "Имя УЗ", required: true }), {
    key: "account_name",
    label: "Имя УЗ",
    type: "text",
    required: true,
  });
  // Только строгое true; optional: true имеет приоритет
  assert.equal(parseOpaPrompt({ key: "k", required: "yes" })?.required, undefined);
  assert.equal(parseOpaPrompt({ key: "k", required: true, optional: true })?.required, undefined);
  assert.equal(parseOpaPrompt({ key: "thread", label: "Тред", optional: true })?.optional, true);
  // Подпись по умолчанию - ключ; пустой ключ - не поле
  assert.equal(parseOpaPrompt({ key: " request " })?.label, "request");
  assert.equal(parseOpaPrompt({ key: "", label: "x" }), null);
  assert.equal(parseOpaPrompt("account_name"), null);
});

test("opa_prompts: a suggester with options always has a value and is never required", () => {
  const prompt = parseOpaPrompt({
    key: "trino_cluster",
    label: "Trino кластер",
    type: "suggester",
    required: true,
    options: [
      { id: "trino-etl", label: "trino-etl", values: { password_file: "password.db_etl", n: 1 } },
      { id: "", values: {} },
      { id: "trino-2", values: '{"password_file":"password_db_2"}' },
      { id: "broken", values: "{not json" },
    ],
  });
  assert.ok(prompt);
  assert.equal(prompt.required, undefined);
  assert.deepEqual(prompt.options, [
    { id: "trino-etl", label: "trino-etl", values: { password_file: "password.db_etl", n: "1" } },
    { id: "trino-2", label: undefined, values: { password_file: "password_db_2" } },
    { id: "broken", label: undefined, values: {} },
  ]);
  // Список без вариантов рисуется текстовым полем и подчиняется общему правилу
  assert.equal(parseOpaPrompt({ key: "k", type: "suggester", options: [], required: true })?.required, true);
  assert.equal(parseOpaPrompt({ key: "k", type: "suggester", required: true })?.required, true);
  assert.equal(parseOpaPrompt({ key: "k", type: "suggester" })?.required, undefined);
});
