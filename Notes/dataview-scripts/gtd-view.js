/**
 * Доска GTD: таблица задач по статусам с датами из daily notes.
 * Обновляется при изменении daily/tasks; не реагирует на templates, Trash, Archive.
 */
(async () => {
    const loader = new Function(await app.vault.adapter.read("dataview-scripts/shared/view-loader.js"))();
    await loader.bootstrapTableView(dv, app, {
        viewName: "GTD",
        modulePaths: [
            "dataview-scripts/gtd-view-modules/1-gtd-data-fetcher.js",
            "dataview-scripts/gtd-view-modules/2-gtd-renderer.js",
            "dataview-scripts/shared/view-refresher.js",
            "dataview-scripts/shared/view-scroll.js",
            "dataview-scripts/shared/view-config.js",
            "dataview-scripts/shared/view-data-utils.js",
            "dataview-scripts/shared/view-io.js",
            "dataview-scripts/shared/view-render-utils.js",
            "dataview-scripts/shared/view-ui.js"
        ],
        delay: 500,
        shouldUpdate: (paths) => (file) => {
            const p = file.path;
            if (p.includes(paths.DAILY_FOLDER)) return true;
            return !p.includes(paths.TEMPLATES_FOLDER) && !p.includes(paths.TRASH_FILE) && !p.includes(paths.ARCHIVE_FOLDER) && p !== dv.current().file.path;
        }
    });
})();
