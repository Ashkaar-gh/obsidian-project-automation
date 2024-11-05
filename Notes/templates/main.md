<%*
// Проверяем, содержит ли каталог заметки имя periodic/daily
const isDaily = tp.file.folder(true).includes("periodic/daily");
// Создаем массив с возможными типами заметок
const options = ["задача", "проект"];

// Проверяем, является ли заметка ежедневной
if (isDaily) {
    // Если это ежедневная заметка, то применяем на нее шаблон daily
    tR += await tp.file.include("[[templates/daily]]");
} else {
    // Предлагаем выбрать тип заметки
    const chosenOption = await tp.system.suggester(options, options);

    // Выводим уведомление, если тип заметки не выбран
    if (!chosenOption) {
        new Notice("Тип заметки не выбран, шаблон не применен.");
        return;
    }

    let noteName;
    let fileExists;
    
    // Цикл для проверки имени заметки на уникальность
    do {
        // Предлагаем ввести новое имя для заметки
        noteName = await tp.system.prompt("Введите новое имя для файла:");
        
        if (noteName) {
            // Проверяем, существует ли заметка с таким именем
            fileExists = await tp.file.exists(noteName + ".md");
            
            if (fileExists) {
                // Выводим уведомление, если заметка существует
                new Notice("Заметка с таким именем уже существует. Пожалуйста, выберите другое имя.");
            }
        } else {
            // Выводим уведомление, если пользователь отменил ввод имени заметки
            new Notice("Переименование отменено.");
            break;
        }
    } while (fileExists);
    
    if (noteName && !fileExists) {
        // Переименовываем заметку
        await tp.file.rename(noteName);
    }
    
    if (chosenOption === "задача") {
        // Если тип заметки "задача", применяем к ней шаблон task
        tR += await tp.file.include("[[templates/task]]");
    } else if (chosenOption === "проект") {
        // Если тип заметки "проект", применяем к ней шаблон project
        tR += await tp.file.include("[[templates/project]]");
    }
}
%>