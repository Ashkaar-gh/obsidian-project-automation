<%*
/**
 * Создание заметки: выбор типа и шаблона, подстановки — в template_config.js. Main только склеивает вызовы и пишет результат.
 */
const raw = tp.user.template_config;
const cfg = typeof raw === "function" ? raw(tp, app) : raw;
if (!cfg || typeof cfg.runTypeAndTemplateChoice !== "function") {
    new Notice(cfg ? cfg.get_template_ui().main.scriptRequiredNotice : "Подключите template_config.js в Templater (User Scripts).");
    return;
}

const result = await cfg.runTypeAndTemplateChoice(tp, app);
if (!result) {
    new Notice(cfg.get_template_ui().main.createCancelledNotice);
    await app.vault.trash(tp.config.target_file, true);
    return;
}
let { noteName, chosenTemplate, chosenOptionKey } = result;
const mainUi = cfg.get_template_ui().main;
const projectUi = cfg.get_template_ui().project;
if (!chosenTemplate) {
    new Notice(mainUi.emptyNoteNotice);
    return;
}

const templatePath = cfg.getTemplatesFolder() + "/" + chosenTemplate + ".md";
const templateFile = app.vault.getAbstractFileByPath(templatePath) || tp.file.find_tfile(chosenTemplate);
let templateContent = await app.vault.read(templateFile);

const templateAlgorithm = (chosenOptionKey === "задача") ? "task" : (chosenOptionKey === "проект") ? "project" : cfg.get_template_algorithm(chosenTemplate);

if (templateAlgorithm === "task") {
    const io = {
        selectItemsFromSection: tp.user.select_items_from_section,
        linkToDailyNote: tp.user.link_to_daily_note
    };
    const taskResult = await cfg.applyTaskReplacements(tp, app, templateContent, noteName, io, chosenTemplate);
    templateContent = taskResult.content;
    var fileToOpenAtEnd = taskResult.fileToOpenAtEnd;
}

let customReplacements = await cfg.get_template_prompts(tp, chosenTemplate);
if (customReplacements && customReplacements.__cancelled) {
    new Notice(mainUi.createCancelledNotice);
    return;
}
templateContent = cfg.applyCustomReplacements(templateContent, customReplacements, chosenTemplate);

if (templateAlgorithm === "project") {
    templateContent = templateContent.replace("%%projectName%%", noteName);
}

tR += templateContent;

if (templateAlgorithm === "project") {
    await tp.user.append_item_to_section(projectUi.homepage, projectUi.projectsSection, noteName, projectUi.appendItem);
}

new Notice(`"${noteName}" ${mainUi.createdNotice}`);

if (typeof fileToOpenAtEnd !== "undefined" && fileToOpenAtEnd) {
    await sleep(100);
    const existingLeaf = app.workspace.getLeavesOfType('markdown')
        .find(leaf => leaf.view.file && leaf.view.file.path === fileToOpenAtEnd.path);
    if (existingLeaf) {
        app.workspace.setActiveLeaf(existingLeaf, { focus: true });
    } else {
        await app.workspace.openLinkText(fileToOpenAtEnd.path, tp.file.path(true), true);
    }
}
%>
