<%*
/**
 * Скрипт автозапуска: один раз при старте Obsidian поднимает фоновые процессы — проверка напоминаний и обработка повторяющихся задач.
 */
const RECURRENCE_DEBOUNCE_MS = 2000;
(async () => {
    const app = this.app;
    let dv;
    let attempts = 0;

    while (attempts < 20) {
        if (app.plugins.plugins.dataview?.api) {
            dv = app.plugins.plugins.dataview.api;
            break;
        }
        await new Promise(r => setTimeout(r, 500));
        attempts++;
    }

    if (!dv) {
        new Notice("Startup Error: Не удалось загрузить API Dataview.");
        return;
    }

    async function loadModule(path) {
        if (!(await app.vault.adapter.exists(path))) return null;
        const content = await app.vault.adapter.read(path);
        return new Function(content)();
    }

    const [fetcher, actions, ui, checker, paths] = await Promise.all([
        loadModule("dataview-scripts/reminders-view-modules/1-reminders-fetcher.js"),
        loadModule("dataview-scripts/reminders-view-modules/3-reminders-actions.js"),
        loadModule("dataview-scripts/shared/view-ui.js"),
        loadModule("dataview-scripts/reminders-view-modules/4-reminders-checker.js"),
        loadModule("dataview-scripts/shared/view-paths.js")
    ]);

    if (!fetcher || !actions || !ui || !checker || !paths) {
        new Notice("Startup Error: Не удалось загрузить модули напоминаний.");
        return;
    }

    if (window.ObsidianBackgroundProcess) {
        window.ObsidianBackgroundProcess.stop();
        if (window.ObsidianBackgroundProcess.recurrenceHandler) {
            app.vault.off('modify', window.ObsidianBackgroundProcess.recurrenceHandler);
        }
    }

    const checkerControl = checker.start(dv, app, actions, fetcher, ui, paths);
    let debounceTimer = null;

    const recurrenceHandler = async (file) => {
        if (file.path.includes("templates") || file.path.includes("Trash")) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            if (actions && typeof actions.scanAndProcessRecurrences === 'function') {
                await actions.scanAndProcessRecurrences(file);
            }
            if (checkerControl && typeof checkerControl.checkNow === 'function') {
                checkerControl.checkNow();
            }
        }, RECURRENCE_DEBOUNCE_MS);
    };

    app.vault.on('modify', recurrenceHandler);

    window.ObsidianBackgroundProcess = {
        stop: checkerControl.stop,
        checkNow: checkerControl.checkNow,
        recurrenceHandler: recurrenceHandler
    };

    new Notice("Фоновые процессы запущены.");
})();
%>