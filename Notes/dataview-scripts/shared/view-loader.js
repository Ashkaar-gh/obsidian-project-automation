/**
 * Динамическая загрузка модулей из vault и отрисовка с индикатором загрузки.
 * load(app, modulePaths) — одна точка: модули + paths параллельно.
 */

const PATHS_FILE = "dataview-scripts/shared/view-paths.js";

/** Загрузка модулей по путям (new Function). При ошибке — Notice и null в массиве. */
async function loadModules(app, modulePaths) {
    const loadSingle = async (path) => {
        try {
            const content = await app.vault.adapter.read(path);
            return new Function(content)();
        } catch (e) {
            new Notice(`Ошибка загрузки ${path}: ${e.message}`);
            console.error(e);
            return null;
        }
    };
    return await Promise.all(modulePaths.map(loadSingle));
}

/** Загрузить view-paths.js и выполнить. */
async function loadPaths(app) {
    const content = await app.vault.adapter.read(PATHS_FILE);
    return new Function(content)();
}

/** Модули + paths параллельно. */
async function load(app, modulePaths) {
    const [modules, paths] = await Promise.all([
        loadModules(app, modulePaths),
        loadPaths(app)
    ]);
    return { modules, paths };
}

/** Показать «Загрузка», выполнить renderLogic(), подменить контейнер или ошибку. */
async function renderWithLoader(dv, rendererModule, renderLogic) {
    if (!dv.container || !dv.container.isConnected) return;

    dv.container.innerHTML = "";
    if (rendererModule?.renderLoading) {
        rendererModule.renderLoading(dv.container);
    } else {
        dv.paragraph("Загрузка...");
    }
    await new Promise(r => setTimeout(r, 10));

    let content = null;
    try {
        content = await renderLogic();
    } catch (e) {
        new Notice(e.message || "Ошибка отрисовки");
        console.error(e);
    }
    dv.container.innerHTML = "";
    if (content) {
        dv.container.appendChild(content);
    } else {
        const errEl = document.createElement("p");
        errEl.className = "view-error";
        errEl.textContent = "Ошибка отображения. Проверьте консоль.";
        errEl.style.color = "var(--text-error)";
        dv.container.appendChild(errEl);
    }
}

/** Единая точка входа для project/gtd: load → render (renderWithLoader) → refresher. */
function bootstrapTableView(dv, app, options) {
    const { viewName, modulePaths, delay, shouldUpdate } = options;
    return (async () => {
        const { modules, paths } = await load(app, modulePaths);
        if (!modules || modules.some(m => m == null)) {
            new Notice(`Не загружены модули: ${viewName}`);
            return;
        }
        const [fetcher, renderer, refresher, scroll, config, utils, io, renderUtils, ui] = modules;
        const shouldUpdateFn = typeof shouldUpdate === "function" ? shouldUpdate(paths) : null;

        async function render() {
            await renderWithLoader(dv, { renderLoading: renderUtils.renderLoading }, async () => {
                const data = await fetcher.fetchData(dv, app, config, utils, paths);
                const fragment = document.createDocumentFragment();
                const tempContainer = ui.create("div");
                fragment.appendChild(tempContainer);
                renderer.renderTable(dv, tempContainer, data, scroll, config, io, renderUtils, ui);
                return fragment;
            });
        }

        const delayMs = delay ?? config?.REFRESH_DELAY_MS ?? 500;
        refresher.setup(dv, app, render, { delay: delayMs, shouldUpdate: shouldUpdateFn });
        await render();
    })();
}

return { loadModules, renderWithLoader, loadPaths, load, bootstrapTableView };