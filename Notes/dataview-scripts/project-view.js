/**
 * View проектов: таблица заметок с frontmatter project/status, даты из daily notes.
 * Обновляется при delete/rename, изменении daily или frontmatter (status/project).
 */
(async () => {
    const loader = new Function(await app.vault.adapter.read("dataview-scripts/shared/view-loader.js"))();
    await loader.bootstrapTableView(dv, app, {
        viewName: "Проекты",
        modulePaths: [
            "dataview-scripts/project-view-modules/1-project-data-fetcher.js",
            "dataview-scripts/project-view-modules/2-project-renderer.js",
            "dataview-scripts/shared/view-refresher.js",
            "dataview-scripts/shared/view-scroll.js",
            "dataview-scripts/shared/view-config.js",
            "dataview-scripts/shared/view-data-utils.js",
            "dataview-scripts/shared/view-io.js",
            "dataview-scripts/shared/view-render-utils.js",
            "dataview-scripts/shared/view-ui.js"
        ],
        delay: 500,
        shouldUpdate: (paths) => (file, reason, cache) => {
            if (reason === "delete" || reason === "rename") return true;
            if (!cache) return true;
            if (file.path.includes(paths.DAILY_FOLDER)) return true;
            return cache.frontmatter && (cache.frontmatter.status || cache.frontmatter.project);
        }
    });
})();
