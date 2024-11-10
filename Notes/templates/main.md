<%*
// Проверяем, содержит ли каталог заметки имя periodic/daily
const isDaily = tp.file.folder(true).includes("periodic/daily");

// Добавляем опцию завершения выбора
const doneOption = "<Без шаблона>";
const taskOption = "задача";
const projectOption = "проект";
const kanbanOption = "kanban";

// Создаем массив с возможными типами заметок, включая опцию завершения
const options = [doneOption, taskOption, projectOption, kanbanOption];

// Проверяем, является ли заметка ежедневной
if (isDaily) {
    // Если это ежедневная заметка, то применяем на нее шаблон daily
    tR += await tp.file.include("[[templates/daily]]");
} else {
    let chosenOption;

    // Предлагаем выбрать тип заметки с возможностью завершения выбора
    chosenOption = await tp.system.suggester(options, options, false, "Выберите шаблон для заметки или нажмите <Без шаблона>");

    // Если пользователь выбрал "Завершить выбор" или нажал Esc
    if (!chosenOption || chosenOption === doneOption) {
        new Notice("Тип заметки не выбран, шаблон не применен.");
        return;
    }

    let noteName;
    let fileExists;
    let filePath;

    // Цикл для проверки имени заметки на уникальность
    do {
        // Предлагаем ввести новое имя для заметки
        noteName = await tp.system.prompt("Введите новое имя для файла:");

        if (noteName) {
            // Если выбран тип "kanban", добавляем папку в путь
            if (chosenOption === kanbanOption) {
                filePath = 'kanban/' + noteName;
            } else {
                filePath = noteName;
            }

            // Проверяем, существует ли заметка с таким именем
            fileExists = await tp.file.exists(filePath);

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
        if (chosenOption === kanbanOption) {
            // Перемещаем заметку типа kanban в каталог kanban
            await tp.file.move(filePath);
        } else {
            // Переименовываем файл
            await tp.file.rename(noteName);
        }
    }

    // Применяем соответствующий шаблон
    if (chosenOption === taskOption) {
        // Если тип заметки "задача", применяем к ней шаблон task
        tR += await tp.file.include("[[templates/task]]");
    } else if (chosenOption === projectOption) {
        // Если тип заметки "проект", применяем к ней шаблон project
        tR += await tp.file.include("[[templates/project]]");
    } else if (chosenOption === kanbanOption) {
        // Если тип заметки "kanban", применяем к ней шаблон kanban
        tR += await tp.file.include("[[templates/kanban]]");
    }
}
%>