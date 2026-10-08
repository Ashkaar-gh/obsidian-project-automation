const SECTION_STORAGE_PREFIX = "opa-section-collapsed-";

function readCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(SECTION_STORAGE_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(SECTION_STORAGE_PREFIX + key, "1");
    else localStorage.removeItem(SECTION_STORAGE_PREFIX + key);
  } catch {
    // ignore
  }
}

export interface CollapsibleSectionOptions {
  /** Текстовая стрелка ▼/▶ как у напоминаний (СЕГОДНЯ), иначе SVG-шеврон */
  useTextArrow?: boolean;
}

export function createCollapsibleSection(
  container: HTMLElement,
  title: string,
  storageKey: string,
  options?: CollapsibleSectionOptions
): HTMLElement {
  const useTextArrow = options?.useTextArrow ?? false;
  const wrap = container.createEl("div", { cls: "opa-section" });

  const header = wrap.createEl("div", { cls: "opa-section-header" });

  const indicator = header.createEl("div", { cls: "opa-collapse-indicator" });
  indicator.setAttribute("aria-label", "Свернуть/развернуть");
  if (useTextArrow) {
    indicator.addClass("opa-collapse-indicator-text");
  }
  const updateArrow = (collapsed: boolean) => {
    if (useTextArrow) {
      indicator.empty();
      indicator.createEl("span", { cls: "opa-collapse-arrow-char", text: collapsed ? "▶" : "▼" });
    }
  };

  if (!useTextArrow) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.classList.add("svg-icon", "right-triangle");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M6 9L12 15L18 9");
    svg.appendChild(path);
    indicator.appendChild(svg);
  }

  header.createEl("h4", { cls: "opa-section-title", text: title });

  const body = wrap.createEl("div", { cls: "opa-section-body" });

  let collapsed = readCollapsed(storageKey);
  if (collapsed) {
    body.style.display = "none";
    indicator.addClass("is-collapsed");
  }
  if (useTextArrow) updateArrow(collapsed);

  const toggle = () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "";
    indicator.toggleClass("is-collapsed", collapsed);
    if (useTextArrow) updateArrow(collapsed);
    writeCollapsed(storageKey, collapsed);
  };

  indicator.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    toggle();
  });

  return body;
}

export interface ToggleSectionOptions {
  /** Иконка перед заголовком (например 🔥). */
  icon?: string;
  title: string;
  count?: number;
  collapsed: boolean;
  onToggle: (collapsed: boolean) => void;
  /** Классы для заголовка/списка (в дополнение к базовым). */
  headerCls?: string;
  listCls?: string;
  /** Тег заголовка (по умолчанию h3). */
  headerTag?: keyof HTMLElementTagNameMap;
}

/**
 * Секция с заголовком-переключателем «▶/▼ Название (N)» и сворачиваемым списком.
 * Используется в напоминаниях и блокноте (секции, архив, группы архива).
 */
export function createToggleSection(
  parent: HTMLElement,
  options: ToggleSectionOptions
): { header: HTMLElement; list: HTMLElement } {
  const header = parent.createEl(options.headerTag ?? "h3", {
    cls: `opa-collapsible-header ${options.headerCls ?? "rv-section-header"}`,
  });
  const arrow = header.createEl("span", { cls: "rv-section-arrow", text: options.collapsed ? "▶" : "▼" });
  const titleSpan = header.createEl("span", { cls: "rv-section-title-text" });
  titleSpan.setText(options.icon ? `${options.icon} ${options.title}` : options.title);
  if (options.count != null) {
    header.createEl("span", { cls: "rv-count", text: String(options.count) });
  }
  const list = parent.createEl("div", { cls: options.listCls ?? "rv-list" });
  list.toggleClass("opa-hidden", options.collapsed);
  header.addEventListener("click", () => {
    const collapsed = !list.hasClass("opa-hidden");
    list.toggleClass("opa-hidden", collapsed);
    arrow.textContent = collapsed ? "▶" : "▼";
    options.onToggle(collapsed);
  });
  return { header, list };
}

