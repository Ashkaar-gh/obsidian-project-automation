/**
 * View напоминаний: задачи с меткой @date (и опционально time), группировка просрочено/сегодня/завтра/позже.
 * После обновления дергает ObsidianBackgroundProcess.checkNow() для проверки уведомлений.
 */
(async () => {
    const { obsidian } = input;

    const loader = new Function(await app.vault.adapter.read("dataview-scripts/shared/view-loader.js"))();
    const { modules, paths } = await loader.load(app, [
        "dataview-scripts/reminders-view-modules/1-reminders-fetcher.js",
        "dataview-scripts/reminders-view-modules/2-reminders-renderer.js",
        "dataview-scripts/reminders-view-modules/3-reminders-actions.js",
        "dataview-scripts/shared/view-refresher.js",
        "dataview-scripts/shared/view-ui.js",
        "dataview-scripts/shared/view-render-utils.js",
        "dataview-scripts/shared/view-config.js"
    ]);
    const [fetcher, renderer, actions, refresher, ui, renderUtils, config] = modules;
    if (!modules || modules.some(m => m == null)) {
        new Notice("Не загружены модули: Напоминания");
        return;
    }

    async function render() {
        if (!dv.container || !dv.container.isConnected) return;
        try {
            const data = await fetcher.fetchReminders(dv, app, paths);
            const container = ui.create("div", { cls: "reminders-wrapper" });
            await renderer.renderReminders(dv, container, data, actions, performUpdate, ui, renderUtils, paths);
            dv.container.innerHTML = "";
            dv.container.appendChild(container);
            if (typeof window !== 'undefined' && window.__remindersFocusAddInput) {
                const input = container.querySelector('.view-input');
                if (input) input.focus();
                clearTimeout(window.__remindersFocusAddInputTimer);
                window.__remindersFocusAddInputTimer = setTimeout(() => { window.__remindersFocusAddInput = false; }, 1500);
            }
        } catch (e) {
            new Notice(e.message || "Ошибка напоминаний");
            console.error(e);
            dv.container.innerHTML = "";
            const errEl = document.createElement("p");
            errEl.className = "view-error";
            errEl.textContent = "Ошибка отображения. Проверьте консоль.";
            errEl.style.color = "var(--text-error)";
            dv.container.appendChild(errEl);
        }
    }

    async function performUpdate() {
        await render();
        if (window.ObsidianBackgroundProcess?.checkNow) window.ObsidianBackgroundProcess.checkNow();
    }

    refresher.setup(dv, app, performUpdate, {
        delay: config?.REFRESH_DELAY_MS_FAST ?? 100,
        watchModify: true,
        shouldUpdate: (file) => !file.path.includes(paths.TEMPLATES_FOLDER) && !file.path.includes(paths.TRASH_FILE)
    });

    const oldUnload = dv.container.onunload;
    dv.container.onunload = () => { if (oldUnload) oldUnload(); };

    await performUpdate();
})();