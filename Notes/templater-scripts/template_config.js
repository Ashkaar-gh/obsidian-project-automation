/**
 * Конфиг шаблонов: список, алгоритмы, тексты окон и подстановки.
 * Подключить в Templater как template_config; в main — tp.user.template_config.*
 *
 * НОВЫЙ ШАБЛОН: добавь объект в TEMPLATE_DEFINITIONS (name, algorithm, при необходимости group и prompts).
 * НОВАЯ ПЕРЕМЕННАЯ: в prompts шаблона добавь элемент:
 *   — prompt:  { type: "prompt", prompt: "Подпись в окне", placeholder: "%%имя%%" }
 *   — опциональная строка (если пусто — строка удаляется): добавь optionalLine: true, в placeholder — вся строка, напр. "Задача: %%task%%"
 *   — обязательное поле: добавь required: true
 *   — выбор из списка: { type: "suggester", prompt: "Подпись", options: [ { id: "вариант1", "%%key%%": "значение1" }, ... ] }
 *   — вычисляемое поле: { type: "computed", placeholder: "%%out%%", emptyKey: "%%key%%", template: "текст с %%key%%", templateWhenEmpty: "текст без key" }
 */
const TEMPLATE_UI = {
    main: {
        templatePrompt: "Шаблон",
        noteNamePrompt: "Введите имя для заметки",
        scriptRequiredNotice: "Подключите template_config.js в Templater (User Scripts).",
        createCancelledNotice: "Создание заметки отменено.",
        createdNotice: "Успешно создан!",
        noteExistsNotice: "Заметка с таким именем уже существует.",
        noteNameRequiredNotice: "Имя заметки обязательно.",
        fieldRequiredNotice: "Поле обязательно для заполнения.",
        emptyNoteNotice: "Создана пустая заметка.",
        inboxCreatingNotice: "Автоматическое создание задачи..."
    },
    task: {
        homepage: "Homepage.md",
        projects: { section: "Проекты", prompt: "Выберите проект(ы)" },
        contexts: { section: "Контексты", prompt: "Выберите контекст(ы)" },
        environment: { section: "Окружение", prompt: "Выберите окружение" },
        dailyNote: {
            question: "Создание заголовка в ежедневной заметке",
            options: ["Сегодняшний день", "Выбрать день", "Не создавать заголовок"],
            optionToday: "Сегодняшний день",
            optionNo: "Не создавать заголовок",
            datePrompt: "Дата (ДД-ММ-ГГГГ)",
            templateNotFoundNotice: "Шаблон для ежедневных заметок 'daily' не найден!",
            createdNotice: (date) => `Создана ежедневная заметка: ${date}`
        },
        selectItems: {
            fileNotFound: (fp) => `Ошибка: файл "${fp}" не найден.`,
            sectionNotFound: (section, fp) => `Секция "${section}" не найдена в файле "${fp}".`,
            sectionEmpty: (section) => `Секция "${section}" пуста.`,
            noListItems: (section) => `В секции "${section}" нет элементов списка.`,
            doneOption: "<Завершить выбор>",
            added: (choice) => `Добавлено: "${choice}"`,
            allSelected: "Все доступные элементы выбраны."
        }
    },
    project: {
        homepage: "Homepage.md",
        projectsSection: "Проекты",
        appendItem: {
            fileNotFound: (fp) => `Ошибка: файл "${fp}" не найден.`,
            sectionNotFound: (section, fp) => `Ошибка: секция "${section}" не найдена в файле "${fp}".`,
            alreadyExists: (item, section) => `Элемент "${item}" уже существует в секции "${section}". Добавление отменено.`,
            added: (item, section) => `Элемент "${item}" добавлен в секцию "${section}".`
        }
    }
};

const TEMPLATE_DEFINITIONS = [
    { name: "task", algorithm: "task", group: "" },
    { name: "project", algorithm: "project" },
    {
        name: "task-example",
        algorithm: "task",
        group: "Пример: задача с доп. полями",
        prompts: [
            { type: "prompt", prompt: "Задача", placeholder: "Задача: %%task%%", optionalLine: true },
            { type: "prompt", prompt: "Реквест", placeholder: "Реквест: %%request%%", optionalLine: true },
            { type: "prompt", prompt: "Тред", placeholder: "Тред: %%thread%%", optionalLine: true },
            { type: "prompt", prompt: "Название элемента", placeholder: "%%item_name%%", required: true },
            { type: "suggester", prompt: "Категория", options: [
                { id: "категория A", "%%category%%": "категория A", "%%config_file%%": "config_a.yaml" },
                { id: "категория B", "%%category%%": "категория B", "%%config_file%%": "config_b.yaml" }
            ] }
        ]
    },
    {
        name: "task-example-advanced",
        algorithm: "task",
        group: "Пример: деплой с коммитом",
        prompts: [
            { type: "prompt", prompt: "Задача", placeholder: "Задача: %%task%%", optionalLine: true },
            { type: "prompt", prompt: "Реквест", placeholder: "Реквест: %%request%%", optionalLine: true },
            { type: "prompt", prompt: "Тред", placeholder: "Тред: %%thread%%", optionalLine: true },
            { type: "suggester", prompt: "Окружение", options: [
                { id: "prod", "%%config_file%%": "values_prod.yaml", "%%environment%%": "prod" },
                { id: "dev", "%%config_file%%": "values_dev.yaml", "%%environment%%": "dev" }
            ] },
            { type: "computed", placeholder: "%%commit_message%%", emptyKey: "%%task%%", template: "%%task%%: update on %%environment%%", templateWhenEmpty: "update on %%environment%%" }
        ]
    }
];

const TEMPLATE_LIST = TEMPLATE_DEFINITIONS.map((d) => d.name);
const TEMPLATE_ALGORITHM = Object.fromEntries(TEMPLATE_DEFINITIONS.map((d) => [d.name, d.algorithm]));
const TEMPLATE_GROUP = Object.fromEntries(TEMPLATE_DEFINITIONS.filter((d) => d.group !== undefined).map((d) => [d.name, d.group]));
const TEMPLATE_PROMPTS = Object.fromEntries(TEMPLATE_DEFINITIONS.filter((d) => d.prompts && d.prompts.length).map((d) => [d.name, d.prompts]));

const DEFAULT_TASK_TEMPLATE = "task";

function getValueKey(placeholder) {
    const m = (placeholder || "").match(/%%[^%]+%%/);
    return m ? m[0] : placeholder;
}

async function get_template_prompts(tp, templateName) {
    const steps = TEMPLATE_PROMPTS[templateName];
    if (!steps || steps.length === 0) return null;
    const replacements = {};
    for (const step of steps) {
        if (step.type === "prompt") {
            const defaultValue = step.defaultValue !== undefined ? step.defaultValue : "";
            let value;
            do {
                value = await tp.system.prompt(step.prompt, defaultValue);
                if (value == null) return { __cancelled: true };
                if (!step.required || String(value).trim()) break;
                new Notice(TEMPLATE_UI.main.fieldRequiredNotice);
            } while (true);
            const key = step.optionalLine ? getValueKey(step.placeholder) : step.placeholder;
            replacements[key] = value;
        } else if (step.type === "suggester") {
            const labels = step.options.map(o => o.id);
            const chosen = await tp.system.suggester(labels, labels, false, step.prompt);
            if (chosen == null) return { __cancelled: true };
            const option = step.options.find(o => o.id === chosen);
            Object.keys(option).filter(k => k !== "id").forEach(k => { replacements[k] = option[k]; });
        } else if (step.type === "computed") {
            const emptyVal = replacements[step.emptyKey];
            const templateStr = (emptyVal != null && String(emptyVal).trim()) ? step.template : step.templateWhenEmpty;
            let out = templateStr;
            for (const [k, v] of Object.entries(replacements)) {
                if (k !== "__cancelled" && v != null) out = out.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), String(v));
            }
            replacements[step.placeholder] = out;
        }
    }
    return replacements;
}

function get_template_algorithm(templateName) {
    if (!(templateName in TEMPLATE_ALGORITHM)) return null;
    return TEMPLATE_ALGORITHM[templateName] === "project" ? "project" : "task";
}

function get_template_ui() {
    return TEMPLATE_UI;
}

function get_template_list() {
    return TEMPLATE_LIST;
}

function get_template_list_by_algorithm(algorithm) {
    return TEMPLATE_LIST.filter(name => get_template_algorithm(name) === algorithm);
}

const TEMPLATES_FOLDER = "templates";

function get_template_options() {
    return ["<Без шаблона>", ...TEMPLATE_LIST];
}

async function resolveDailyNoteChoice(tp) {
    const ui = TEMPLATE_UI.task.dailyNote;
    while (true) {
        const choice = await tp.system.suggester(ui.options, ui.options, false, ui.question);
        if (!choice || choice === ui.optionNo) return null;
        if (choice === ui.optionToday) return { dateStr: null };
        const today = tp.date.now("DD-MM-YYYY");
        const dateStr = await tp.system.prompt(ui.datePrompt, today);
        if (dateStr == null) continue;
        if (dateStr && /^\d{2}-\d{2}-\d{4}$/.test(dateStr.trim())) return { dateStr: dateStr.trim() };
    }
}

async function runTypeAndTemplateChoice(tp, app) {
    const mainUi = TEMPLATE_UI.main;
    const isInboxRun = !!window.INBOX_CONTEXT;

    if (isInboxRun) {
        new Notice(mainUi.inboxCreatingNotice);
        const context = window.INBOX_CONTEXT;
        const noteName = context.noteName;
        delete window.INBOX_CONTEXT;
        const chosenTemplate = TEMPLATE_LIST.includes(DEFAULT_TASK_TEMPLATE) ? DEFAULT_TASK_TEMPLATE : get_template_list_by_algorithm("task")[0];
        if (!chosenTemplate) return null;
        if (tp.file.title !== noteName) await tp.file.rename(noteName);
        return { noteName, chosenTemplate, chosenOptionKey: "задача" };
    }

    const templateOptions = get_template_options();
    const chosen = await tp.system.suggester(templateOptions, templateOptions, false, mainUi.templatePrompt);
    if (!chosen) return null;
    if (chosen === "<Без шаблона>") return { noteName: tp.file.title, chosenTemplate: null, chosenOptionKey: null };
    const chosenTemplate = chosen;
    const algorithm = get_template_algorithm(chosenTemplate);
    const resolvedKey = algorithm === "project" ? "проект" : "задача";

    let noteName = tp.file.title;
    const isDefaultName = /^Untitled( \d*)?$/.test(noteName);
    let promptValue = isDefaultName ? "" : noteName;
    while (true) {
        noteName = await tp.system.prompt(`${mainUi.noteNamePrompt} (${resolvedKey}):`, promptValue);
        if (noteName == null) return null;
        if (!String(noteName).trim()) {
            new Notice(mainUi.noteNameRequiredNotice);
            continue;
        }
        noteName = noteName.trim();
        if (noteName === tp.file.title) break;
        if (await tp.file.exists(`${noteName}.md`)) {
            new Notice(mainUi.noteExistsNotice);
            promptValue = noteName;
        } else break;
    }
    if (noteName !== tp.file.title) await tp.file.rename(noteName);
    return { noteName, chosenTemplate, chosenOptionKey: resolvedKey };
}

async function applyTaskReplacements(tp, app, templateContent, noteName, io, templateName) {
    const taskUi = TEMPLATE_UI.task;
    const selectItemsUi = taskUi.selectItems;
    const selectedProjects = await io.selectItemsFromSection(tp, taskUi.homepage, taskUi.projects.section, taskUi.projects.prompt, selectItemsUi);
    const selectedContexts = await io.selectItemsFromSection(tp, taskUi.homepage, taskUi.contexts.section, taskUi.contexts.prompt, selectItemsUi);
    const selectedEnvs = await io.selectItemsFromSection(tp, taskUi.homepage, taskUi.environment.section, taskUi.environment.prompt, selectItemsUi);
    const formatYamlList = (list) => list.length > 0 ? '\n' + list.map(i => `  - ${i}`).join('\n') : '';
    const currentDate = tp.date.now("YYYY-MM-DD");
    const groupValue = templateName in TEMPLATE_GROUP ? TEMPLATE_GROUP[templateName] : noteName;
    let content = templateContent
        .replace("%%project%%", formatYamlList(selectedProjects))
        .replace("%%environment%%", formatYamlList(selectedEnvs))
        .replace("%%context%%", formatYamlList(selectedContexts))
        .replace("%%date%%", currentDate)
        .replace(/%%group%%/g, groupValue);
    const dailyChoice = await resolveDailyNoteChoice(tp);
    let fileToOpenAtEnd = null;
    if (dailyChoice) fileToOpenAtEnd = await io.linkToDailyNote(tp, app, noteName, dailyChoice.dateStr, taskUi.dailyNote);
    return { content, fileToOpenAtEnd };
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyCustomReplacements(templateContent, replacements, templateName) {
    if (!replacements || replacements.__cancelled) return templateContent;
    let out = templateContent;
    const steps = TEMPLATE_PROMPTS[templateName];
    const optionalPlaceholders = new Set();
    if (steps) {
        for (const step of steps) {
            if (step.optionalLine && step.placeholder) {
                const valueKey = getValueKey(step.placeholder);
                optionalPlaceholders.add(valueKey);
                const value = replacements[valueKey];
                const lineRe = new RegExp("^\\s*" + escapeRe(step.placeholder) + "\\s*\\n?", "gm");
                const lineValue = (value != null && String(value).trim())
                    ? step.placeholder.replace(valueKey, String(value).trim()) + "\n"
                    : "\n";
                out = out.replace(lineRe, lineValue);
            }
        }
    }
    for (const [key, value] of Object.entries(replacements)) {
        if (key === "__cancelled" || optionalPlaceholders.has(key)) continue;
        if (value != null)
            out = out.replace(new RegExp(escapeRe(key), "g"), value);
    }
    return out;
}

function getTemplatesFolder() {
    return TEMPLATES_FOLDER;
}

const templateConfig = {
    get_template_prompts,
    get_template_algorithm,
    get_template_ui,
    get_template_list,
    get_template_list_by_algorithm,
    get_template_options,
    resolveDailyNoteChoice,
    runTypeAndTemplateChoice,
    applyTaskReplacements,
    applyCustomReplacements,
    getTemplatesFolder
};

module.exports = function(tp, app) {
    return templateConfig;
};
