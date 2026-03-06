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
    indicator.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon right-triangle"><path d="M6 9L12 15L18 9"></path></svg>';
  }

  const titleEl = header.createEl("h4", {
    cls: "opa-section-title",
    text: title,
  });

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

