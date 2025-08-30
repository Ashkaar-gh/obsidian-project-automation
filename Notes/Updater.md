```dataviewjs
// Пути к шаблонам
const PROJECT_TEMPLATE_PATH = "templates/project.md";
const TASK_TEMPLATE_PATH = "templates/task.md";

// Правильные CSS классы для frontmatter проектов
const correctProjectCssClasses = ['wide-page', 'table-divider'];
// Правильные CSS классы для frontmatter задач
const correctTaskCssClasses = ['wide-page'];

// Находит dataviewjs блок
const dvjsRegex = /```dataviewjs\s*[\s\S]*?\s*```/s;

/**
 * Извлекает список ссылок из указанной секции файла Homepage.md.
 * @param {string} content - Содержимое файла Homepage.md.
 * @param {string} sectionTitle - Название секции (например, "Проекты").
 * @returns {string[]} - Массив имен файлов без расширения .md.
 */
function getLinksFromSection(content, sectionTitle) {
    // Регулярное выражение для поиска заголовка вида "### Заголовок:"
    const sectionRegex = new RegExp(`### ${sectionTitle}:\\n([\\s\\S]*?)(?=\\n###|$)`);
    // Ищем совпадение в тексте
    const match = content.match(sectionRegex);
    // Если секция не найдена, возвращаем пустой массив
    if (!match) return [];
    // Извлекаем содержимое секции (текст между заголовками)
    const sectionContent = match[1];
    // Находим все ссылки вида "- [[Имя]]" и возвращаем массив имен
    return [...sectionContent.matchAll(/- \[\[(.*?)]]/g)].map(m => m[1]);
}

/**
 * Универсальная функция для валидации и коррекции свойств (project, kanban).
 * @param {string|string[]} propertyValue - Значение свойства из frontmatter.
 * @param {string[]} validNames - "Белый список" правильных имен.
 * @param {string[]} validNamesLower - "Белый список" в нижнем регистре для сравнения.
 * @param {string} propertyName - Имя свойства для отчетов.
 * @returns {object} - Объект с результатами проверки.
 */
function validateAndCorrectProperty(propertyValue, validNames, validNamesLower, propertyName) {
    // Если свойства нет, это проблема для ручного решения
    if (!propertyValue) return { needsManualFix: true, report: `отсутствует '${propertyName}'` };

    // Приводим значение к массиву для единообразной обработки
    const originalItems = Array.isArray(propertyValue) ? propertyValue : [propertyValue];
    let correctedItems = [];
    // Флаг, если есть несовпадение по регистру
    let hasCaseMismatch = false;
    // Флаг, если есть значение, которого нет в белом списке
    let hasInvalidItem = false;

    // Проверяем каждый элемент в массиве
    for (const item of originalItems) {
        const trimmedItem = String(item).trim();
        const lowerItem = trimmedItem.toLowerCase();
        // Ищем совпадение в белом списке (без учета регистра)
        const canonicalIndex = validNamesLower.indexOf(lowerItem);

        if (canonicalIndex === -1) {
            // Если совпадения нет, это неисправимая ошибка
            hasInvalidItem = true;
            correctedItems.push(trimmedItem);
        } else {
            // Если совпадение есть, берем каноническое имя из белого списка
            const canonicalName = validNames[canonicalIndex];
            correctedItems.push(canonicalName);
            // Если каноническое имя не совпадает с исходным, значит, был неверный регистр
            if (trimmedItem !== canonicalName) hasCaseMismatch = true;
        }
    }

    // Собираем исправленное значение, сохраняя исходный тип (строка или массив)
    const correctedValue = originalItems.length === 1 && !Array.isArray(propertyValue) ? correctedItems[0] : correctedItems;
    // Проверяем, изменилось ли что-то
    const isModified = JSON.stringify(propertyValue) !== JSON.stringify(correctedValue);
    
    let report = "";
    if (hasInvalidItem) {
        report = `неверное значение '${propertyName}' (нет в Homepage.md)`;
    } else if (hasCaseMismatch) {
        report = `неверный регистр в '${propertyName}'`;
    }

    // Возвращаем подробный результат
    return { isModified, correctedValue, needsManualFix: hasInvalidItem, report };
}

/**
 * Основная функция, которая запускает весь процесс анализа и обновления.
 * @param {boolean} isDryRun - Если true, скрипт только анализирует. Если false - вносит изменения.
 */
async function runUpdate(isDryRun) {
    // Получаем контейнер для вывода отчета в текущей заметке
    const container = dv.container;
    // Очищаем его перед каждым запуском, чтобы отчеты не дублировались
    container.innerHTML = '';

    // Создаем дочерние контейнеры для отчета и для кнопки
    const reportContainer = container.appendChild(document.createElement('div'));
    const buttonContainer = container.appendChild(document.createElement('div'));

    // Загрузка шаблонов
    const projectTemplateFile = app.vault.getAbstractFileByPath(PROJECT_TEMPLATE_PATH);
    const taskTemplateFile = app.vault.getAbstractFileByPath(TASK_TEMPLATE_PATH);
    if (!projectTemplateFile || !taskTemplateFile) { dv.el('div', "Критическая ошибка: файл шаблона не найден.", { parent: reportContainer }); return; }
    const projectTemplateContent = await app.vault.cachedRead(projectTemplateFile);
    const taskTemplateContent = await app.vault.cachedRead(taskTemplateFile);
    // Извлекаем эталонные dataviewjs блоки из шаблонов
    const newProjectDvjsBlock = (projectTemplateContent.match(dvjsRegex) || [null])[0];
    const newTaskDvjsBlock = (taskTemplateContent.match(dvjsRegex) || [null])[0];
    if (!newProjectDvjsBlock || !newTaskDvjsBlock) { dv.el('div', "Критическая ошибка: не удалось извлечь dataviewjs блок из шаблона.", { parent: reportContainer }); return; }

    // Идентификация
    const homepageFile = app.vault.getAbstractFileByPath("Homepage.md");
    if (!homepageFile) { dv.el('div', "Критическая ошибка: файл Homepage.md не найден!", { parent: reportContainer }); return; }
    const homepageContent = await app.vault.cachedRead(homepageFile);
    // Получаем "белые списки" проектов и канбан-досок
    const validProjectNames = getLinksFromSection(homepageContent, "Проекты");
    const validKanbanNames = getLinksFromSection(homepageContent, "Kanban");
    // Создаем их версии в нижнем регистре для "умного" сравнения
    const validProjectNamesLower = validProjectNames.map(name => name.toLowerCase());
    const validKanbanNamesLower = validKanbanNames.map(name => name.toLowerCase());
    if (validProjectNames.length === 0) { dv.el('div', "Не удалось найти проекты в Homepage.md.", { parent: reportContainer }); return; }
    
    // Проект должен быть в  Homepage и содержать поле 'project'
    const projectFilePaths = validProjectNames.map(name => name + ".md").filter(path => dv.page(path) && dv.page(path).project);
    // Задачи не должно быть в Homepage, но в ней так же должно быть поле 'project'
    const taskFilePaths = dv.pages('""').where(p => p.project && !validProjectNames.includes(p.file.name)).map(p => p.file.path);

    // Обработка файлов
    const allIssues = [];
    // Обработка проектов
    for (const path of projectFilePaths) {
        const file = app.vault.getAbstractFileByPath(path);
        if (!file) continue;
        const page = dv.page(path);
        if (!page) continue;
        let autoCorrections = [];
        // Проверяем поле 'project', должно быть строкой или массивом из одной строки
        let projectIsCorrect = !page.project || (typeof page.project === 'string' && page.project.trim() === file.basename) || (Array.isArray(page.project) && page.project.length === 1 && String(page.project[0]).trim() === file.basename);
        if (!projectIsCorrect) autoCorrections.push("неверное значение 'project'");
        // Проверяем cssclasses
        if (JSON.stringify(page.cssclasses || []) !== JSON.stringify(correctProjectCssClasses)) autoCorrections.push("неверные 'cssclasses'");
        // Проверяем dataviewjs код
        const originalContent = await app.vault.cachedRead(file);
        const currentDvjsBlock = (originalContent.match(dvjsRegex) || [null])[0];
        if (currentDvjsBlock && currentDvjsBlock !== newProjectDvjsBlock) {
            autoCorrections.push("устаревший dataviewjs код");
        }
        
        // Если нашли проблемы, добавляем в отчет
        if (autoCorrections.length > 0) {
            allIssues.push({ filePath: path, type: 'Проект', autoCorrections, manualIssues: [] });
            // Если не dry run, применяем исправления
            if (!isDryRun) {
                // Исправляем frontmatter
                await app.fileManager.processFrontMatter(file, (fm) => { 
                    fm.project = file.basename; // Всегда приводим к строке
                    fm.cssclasses = correctProjectCssClasses; 
                });
                // Исправляем dataviewjs, только если он был
                if (currentDvjsBlock) {
                    const updatedFrontmatterContent = await app.vault.cachedRead(file);
                    const finalContent = updatedFrontmatterContent.replace(dvjsRegex, newProjectDvjsBlock);
                    await app.vault.modify(file, finalContent);
                }
            }
        }
    }
    // Обработка Задач
    for (const path of taskFilePaths) {
        const file = app.vault.getAbstractFileByPath(path);
        if (!file) continue;
        const page = dv.page(path);
        if (!page) continue;
        let manualIssues = [], autoCorrections = [];
        
        // Валидация 'project' и 'kanban'
        const projectValidation = validateAndCorrectProperty(page.project, validProjectNames, validProjectNamesLower, 'project');
        if (projectValidation.needsManualFix) manualIssues.push(projectValidation.report); 
        else if (projectValidation.isModified) autoCorrections.push("неверный регистр в 'project'");
        
        const kanbanValidation = validateAndCorrectProperty(page.kanban, validKanbanNames, validKanbanNamesLower, 'kanban');
        if (kanbanValidation.needsManualFix) manualIssues.push(kanbanValidation.report); 
        else if (kanbanValidation.isModified) autoCorrections.push("неверный регистр в 'kanban'");

        // Проверяем наличие обязательных полей
        if (page.instance === undefined) manualIssues.push("отсутствует 'instance'");
        if (page.date === undefined) manualIssues.push("отсутствует 'date'");
        
        // Автоматически исправляемая проверка 'cssclasses'
        if (JSON.stringify(page.cssclasses || []) !== JSON.stringify(correctTaskCssClasses)) {
            autoCorrections.push("неверные 'cssclasses'");
        }
        
        // Автоматически исправляемая проверка dataviewjs кода
        const originalContent = await app.vault.cachedRead(file);
        const currentDvjsBlock = (originalContent.match(dvjsRegex) || [null])[0];
        if (currentDvjsBlock && currentDvjsBlock !== newTaskDvjsBlock) {
            autoCorrections.push("устаревший dataviewjs код");
        }
        
        // Если нашли проблемы, добавляем в отчет
        if (manualIssues.length > 0 || autoCorrections.length > 0) {
            allIssues.push({ filePath: path, type: 'Задача', autoCorrections, manualIssues });
            // Если не dry run, применяем автоматические исправления
            if (!isDryRun && autoCorrections.length > 0) {
                // Исправляем frontmatter
                await app.fileManager.processFrontMatter(file, (fm) => {
                    if (projectValidation.isModified) fm.project = projectValidation.correctedValue;
                    if (kanbanValidation.isModified) fm.kanban = kanbanValidation.correctedValue;
                    if (JSON.stringify(fm.cssclasses || []) !== JSON.stringify(correctTaskCssClasses)) fm.cssclasses = correctTaskCssClasses;
                });
                // Исправляем dataviewjs код, только если он был
                if (currentDvjsBlock) {
                    let currentContent = await app.vault.cachedRead(file);
                    if ((currentContent.match(dvjsRegex) || [null])[0] !== newTaskDvjsBlock) {
                        currentContent = currentContent.replace(dvjsRegex, newTaskDvjsBlock);
                    }
                    await app.vault.modify(file, currentContent);
                }
            }
        }
    }

    // Вывод отчета
    dv.el('h2', `Отчет об обновлении (Статус: ${isDryRun ? "🔍 DRY RUN" : "✅ ОБНОВЛЕНИЕ ЗАВЕРШЕНО"})`, { parent: reportContainer });
    
    // Показываем строку "Найдено для проверки" только в режиме "сухого прогона"
    if (isDryRun) {
        dv.el('p', `ℹ️ **Найдено для проверки:** ${projectFilePaths.length} проектов и ${taskFilePaths.length} задач.`, { parent: reportContainer });
    }

    // Определяем, сколько файлов осталось с проблемами после "боевого" прогона
    const manualIssueLog = allIssues.filter(issue => issue.manualIssues.length > 0);
    const finalIssueCount = isDryRun ? allIssues.length : manualIssueLog.length;
    dv.el('p', `**Найдено файлов с несоответствиями:** ${finalIssueCount}`, { parent: reportContainer });

    // Если есть какие-либо проблемы
    if (finalIssueCount > 0) {
        const autoCorrectionLog = allIssues.filter(issue => issue.autoCorrections.length > 0);

        // В режиме dry run показываем, что будет исправлено
        if (isDryRun && autoCorrectionLog.length > 0) {
            dv.el('h4', "Будет автоматически исправлено:", { parent: reportContainer });
            const list = autoCorrectionLog.map(issue => `[[${issue.filePath}]] (${issue.type}) - ${issue.autoCorrections.join(', ')}`);
            dv.list(list, reportContainer);
        }

        // Всегда показываем, что требует ручного внимания
        if (manualIssueLog.length > 0) {
            dv.el('h4', `⚠️ Требуют ручного внимания (${manualIssueLog.length} файлов)`, { parent: reportContainer });
            const list = manualIssueLog.map(issue => `[[${issue.filePath}]] (${issue.type}) - ${issue.manualIssues.join(', ')}`);
            dv.list(list, reportContainer);
        }
    } else {
        // Если проблем нет, выводим сообщение об успехе
        dv.el('p', "✅ Все проекты и задачи соответствуют актуальным шаблонам.", { parent: reportContainer });
    }

    // Показываем кнопку только в dry run и если есть что исправлять
    if (isDryRun && allIssues.length > 0) {
        const button = dv.el("button", "🚀 Запустить обновление");
        // Стили для кнопки
        button.style.backgroundColor = "#4CAF50"; button.style.color = "white"; button.style.border = "none";
        button.style.padding = "10px 20px"; button.style.fontSize = "16px"; button.style.cursor = "pointer";
        button.style.borderRadius = "5px"; button.style.marginTop = "10px";
        // Действие по клику
        button.onclick = () => {
            button.textContent = "Обновление...";
            button.disabled = true;
            // Запускаем эту же функцию в "боевом" режиме
            runUpdate(false);
        };
        // Добавляем кнопку в ее контейнер
        buttonContainer.appendChild(button);
        // Перемещаем контейнер с кнопкой наверх
        container.prepend(buttonContainer);
    }
}

runUpdate(true);
```
