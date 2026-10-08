/**
 * Разбор одного элемента opa_prompts из frontmatter шаблона (поле с текстом или список вариантов
 * со связанными значениями). Формой «Создать задачу» сейчас не используется: поля шаблона из неё убраны,
 * шаблон задаёт только проект, группу и скелет заметки. Оставлен как готовый разбор для сниппетов
 * с подстановкой значений. Чистая логика без Obsidian - покрыта тестами.
 */

/** Описание поля в модалке «Создать задачу» из frontmatter шаблона (opa_prompts). */
export interface OpaPrompt {
  key: string;
  label: string;
  optional?: boolean;
  /**
   * Поле нельзя оставить пустым: в opa_prompts у него явно стоит `required: true` и оно вводится текстом.
   * Все остальные поля необязательны (поля шаблона обычно заполняются не при создании задачи):
   * пустые строки с их плейсхолдерами удаляются из заметки, как и раньше.
   */
  required?: boolean;
  type?: "text" | "suggester";
  options?: Array<{ id: string; label?: string; values: Record<string, string> }>;
}

export function parseOpaPrompt(raw: unknown): OpaPrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const key = typeof o.key === "string" ? o.key.trim() : "";
  const label = typeof o.label === "string" ? o.label.trim() : key;
  if (!key) return null;
  const prompt: OpaPrompt = { key, label };
  if (o.optional === true) prompt.optional = true;
  const type = o.type;
  if (type === "suggester" || type === "text") prompt.type = type;
  else prompt.type = "text";
  if (prompt.type === "suggester" && Array.isArray(o.options)) {
    prompt.options = [];
    for (const opt of o.options) {
      if (!opt || typeof opt !== "object") continue;
      const optObj = opt as Record<string, unknown>;
      const id = String(optObj.id ?? "");
      let values = optObj.values;
      if (typeof values === "string") {
        try {
          values = JSON.parse(values) as Record<string, unknown>;
        } catch {
          values = null;
        }
      }
      if (!id) continue;
      const valuesRecord: Record<string, string> = {};
      if (values && typeof values === "object" && !Array.isArray(values)) {
        for (const [k, v] of Object.entries(values)) {
          if (v != null) valuesRecord[k] = String(v);
        }
      }
      prompt.options.push({
        id,
        label: typeof optObj.label === "string" ? optObj.label : undefined,
        values: valuesRecord,
      });
    }
  }
  // Обязательность только явная (required: true); список с вариантами всегда даёт значение и обязательным не бывает.
  const pickedFromList = prompt.type === "suggester" && (prompt.options?.length ?? 0) > 0;
  if (o.required === true && prompt.optional !== true && !pickedFromList) prompt.required = true;
  return prompt;
}
