/**
 * Пропуск перерисовки блока, если его данные не изменились.
 *
 * Фоновые обновления (смена вкладки, изменение любого файла в хранилище) раньше
 * пересобирали DOM каждого блока целиком: терялись выделение текста, фокус в полях ввода,
 * прокрутка внутри блока, мигал контент. Теперь модуль считает «подпись» данных,
 * от которых зависит отрисовка, и при совпадении с прошлой оставляет DOM как есть.
 */

const signatures = new WeakMap<HTMLElement, string>();

/** true - данные те же, что при последней успешной отрисовке, и в контейнере есть контент. */
export function isRenderUnchanged(el: HTMLElement, signature: string): boolean {
  if (signatures.get(el) !== signature) return false;
  if (!el.firstElementChild) return false;
  if (el.querySelector(".view-error")) return false;
  return true;
}

/** Запомнить подпись после успешной отрисовки. */
export function markRendered(el: HTMLElement, signature: string): void {
  signatures.set(el, signature);
}

/** Забыть подпись (следующая отрисовка гарантированно перерисует блок). */
export function forgetRender(el: HTMLElement): void {
  signatures.delete(el);
}

/** Стабильная подпись произвольных данных (JSON; несериализуемое - по строковому виду). */
export function renderSignature(...parts: unknown[]): string {
  try {
    return JSON.stringify(parts);
  } catch {
    return parts.map((p) => String(p)).join(" ");
  }
}
