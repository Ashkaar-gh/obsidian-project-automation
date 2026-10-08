/** Единый справочник надписей для UI плагина. */

/** «1 запись», «2 записи», «5 записей». */
function entriesCount(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "запись"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "записи"
        : "записей";
  return `${n} ${word}`;
}

export const UI_LABELS = {
  common: {
    save: "Сохранить",
    cancel: "Отмена",
    ok: "ОК",
    add: "Добавить",
    edit: "Изменить",
    copy: "Копировать",
    copied: "Скопировано",
    copyImage: "Копировать изображение",
    imageCopied: "Изображение скопировано",
    nothingToCopy: "Нечего копировать: выделите текст или наведите курсор на блок",
    delete: "Удалить",
    empty: "Пусто",
  },
  errors: {
    loadModules: "Не загружены модули",
    loadData: "Не удалось загрузить данные",
    render: "Ошибка отображения. Проверьте консоль.",
    renderShort: "Ошибка отрисовки",
    fileNotFound: (path: string) => `Ошибка: Файл "${path}" не найден.`,
    copyFailed: "Не удалось скопировать в буфер обмена",
    copyImageFailed: "Не удалось скопировать изображение",
  },
  tasks: {
    total: "Всего задач",
    noActive: "Нет активных задач.",
    noTasks: "Нет задач.",
    noNotes: "Нет заметок.",
    ungrouped: "Задачи без группы",
    noStatus: "Без статуса",
    columns: {
      task: "Задача",
      context: "Контекст",
      project: "Проект",
      environment: "Окружение",
      status: "Статус",
      deadline: "Дедлайн",
      time: "Срок",
    },
    defaultStatus: "В работе",
    statusChangeFailed: "Не удалось изменить статус задачи. Подробности в консоли.",
    statusCommentFailed: "Статус изменён, но комментарий в «Описание задачи» записать не удалось.",
    statusChangePostFailed: "Статус изменён, но обновить связанные данные не удалось. Подробности в консоли.",
  },
  loader: {
    loading: "Загрузка...",
  },
  trash: {
    loadError: "Корзина",
    cleared: "Корзина очищена",
    alreadyEmpty: "Корзина уже пуста",
    clear: "Очистить",
    empty: "Пусто",
    completedBadge: "Из архива",
    nested: "Корзина не показывается внутри записи блокнота",
  },
  inbox: {
    loadError: "Inbox",
    loadDataError: "Не удалось загрузить данные Inbox.",
    empty: "Пусто",
    emptyHint: "Записывать можно откуда угодно: команда «Запись в блокнот», удобнее всего на горячей клавише.",
    addPlaceholder: "Мысль, ссылка, кусок текста, скриншот…",
    actions: {
      done: "Архив",
      task: "Задача",
      edit: "Изменить",
      reminder: "Напоминание",
      delete: "Удалить",
    },
    archiveTitle: "Архив",
    archiveShowEarlier: (count: number) => `Показать более ранние (${count})`,
    nested: "Блокнот не показывается внутри записи блокнота",
    /** Поле «Относится к» в окне записи и подпись привязки под записью. */
    link: {
      label: "Относится к",
      placeholder: "Задача или проект",
      clear: "Убрать привязку",
      projectNote: "проект",
      missing: "Заметка задачи не найдена",
    },
    /** Группа записей с одной привязкой: число записей в заголовке (подсказка). */
    groupCount: (count: number) => entriesCount(count),
    /** Блок «Блокнот» в заметке задачи или проекта: записи, привязанные к ней (в проекте - и к его задачам). */
    noteBlockTitle: (count: number) => `Блокнот (${count})`,
    notices: {
      updated: "Запись обновлена",
      processed: "Запись перемещена в архив",
      emptyName: "Ошибка: имя задачи не может быть пустым.",
      alreadyThere: "Уже есть в блокноте",
      movedToTrash: "Запись перемещена в корзину",
      saveFailed: "Не удалось сохранить запись в блокнот",
      imageFailed: "Не удалось сохранить картинку",
      restNotSaved: "Задача создана, но остальной текст записи в «Описание задачи» не попал: запись осталась в блокноте",
    },
    /** Подсказка при наведении на кнопку сохранения. */
    submitShortcut: "Ctrl+Enter",
    submitShortcutMac: "Cmd+Enter",
    /** Подпись в окне «Запись в блокнот» слева от кнопок. */
    submitHint: (shortcut: string) => `${shortcut} - сохранить`,
    quickCapture: {
      command: "Запись в блокнот",
      title: "Запись в блокнот",
      saved: "Записано в блокнот",
      savedWithLink: (label: string) => `Записано в блокнот: ${label}`,
      disabled: "Блокнот выключен в настройках плагина",
    },
  },
  reminders: {
    /** Команда для горячей клавиши: окно нового напоминания поверх любой заметки. */
    addCommand: "Новое напоминание",
    loadError: "Напоминания",
    errorNotice: "Ошибка напоминаний",
    empty: "Нет активных напоминаний",
    addPlaceholder: "Добавить напоминание",
    edit: "Изменить",
    delete: "Удалить",
    sections: { overdue: "Просрочено", today: "Сегодня", tomorrow: "Завтра", upcoming: "Предстоящие", archive: "Архив" },
    modal: {
      title: "Настройка напоминания",
      /** Заголовок того же окна для «Изменить» у напоминания в блоке. */
      editTitle: "Изменить напоминание",
      textLabel: "Текст напоминания",
      dateLabel: "Дата и время:",
      recurrenceLabel: "Повторение:",
      noRecurrence: "Без повтора",
      days: "Дней",
      weeks: "Недель",
      months: "Месяцев",
      years: "Лет",
      fillRequired: "Заполните текст и дату",
    },
    notices: {
      completed: "Напоминание выполнено",
      updated: "Напоминание обновлено",
      movedToTrash: "Напоминание перемещено в корзину",
      nextCreated: (amount: number, unit: string) => `Создана следующая задача: через ${amount} ${unit}`,
      editNotFound: "Напоминание не изменено: его уже изменили или удалили.",
      deleteNotFound: "Не удалось найти задачу для удаления.",
      completeNotFound: "Не удалось найти задачу для завершения.",
      added: "Напоминание добавлено",
      addedAt: (when: string) => `Напоминание добавлено: ${when}`,
      invalidDate: "Некорректная дата",
      trashNotFound: (path: string) => `Файл ${path} не найден, задача удалена безвозвратно.`,
    },
    snooze: {
      doneBtn: "✅ Выполнено",
      oneHourBtn: "🕐 Отложить на 1 час",
      tomorrowBtn: "☀️ Отложить на завтра",
      pickDateBtn: "📅 Выбрать дату...",
      pickerTitle: "Выберите время переноса",
      done: "Задача выполнена!",
      oneHour: "Перенесено на 1 час",
      tomorrow: "Перенесено на завтра",
      rescheduled: (date: string) => `Перенесено на ${date}`,
    },
  },
  gamification: {
    progress: "Прогресс",
    levelLabel: "Уровень",
    xpToLevel: (current: number, need: number, level: number) => `${current} / ${need} ХР до уровня ${level}`,
    gold: "Gold",
    completed: "Выполненные",
    streaks: "Стрики",
    shopTitle: "МАГАЗИН",
    management: "Управление",
    purchased: "Купленное",
    buy: "Купить",
    name: "Название",
    price: "Цена",
    task: "Задача",
    deadline: "Срок",
    completedOn: "Выполнено",
    reward: "Награда",
    streak: "Стрик",
    days: "Дней",
    day: "день",
    daysCount: (n: number) => (n === 1 ? "1 день" : `${n} дней`),
    clearHistory: "Очистить историю",
    currentMonth: "Текущий месяц",
    rewardsReceived: "Награды получены",
    returnedToWork: "Вернулась в работу",
    rewardLine: (xp: number, gold: number) => `+${xp} XP, +${gold} Gold`,
    shopTitleShort: "Магазин",
    addItem: "Добавить лот",
    description: "Описание",
  },
  /** Заголовки блоков плагина - их же показывает панель «Структура». */
  blockTitles: {
    reminders: "Напоминания",
    projects: "Проекты",
    tasksDashboard: "Доска задач",
    inbox: "Блокнот",
    trash: "Корзина",
    activities: "Активности",
    gamification: "Прогресс",
  },
  outline: {
    title: "Структура",
    titleFor: (name: string) => `Структура: ${name}`,
    openCommand: "Открыть панель «Структура»",
    noFile: "Нет открытой заметки",
    noHeadings: "Заголовков нет",
    noMatches: "Ничего не найдено",
    search: "Поиск по заголовкам",
    searchPlaceholder: "Поиск…",
    collapseAll: "Свернуть все",
    expandAll: "Развернуть все",
    goToEntry: "Перейти к записи",
    openInDaily: "Открыть в ежедневной заметке",
  },
  /** Переход из задачи в проект: проект в свойствах - ссылка, команда «Открыть проект задачи». */
  projectLink: {
    command: "Открыть проект задачи",
    choosePlaceholder: "Какой проект открыть?",
    noNote: (names: readonly string[]) =>
      names.length === 1
        ? `У проекта «${names[0]}» нет заметки. Создать её - команда «Создать проект».`
        : `У проектов ${names.map((name) => `«${name}»`).join(", ")} нет заметок. Создать - команда «Создать проект».`,
  },
  /** Поиск Ctrl+F в режиме редактирования по записям блока задачи. */
  taskSearch: {
    replaceSkipped: (count: number) =>
      count === 1
        ? "Это текст записи из ежедневной заметки - здесь он не заменяется"
        : `Записи из ежедневных заметок не заменялись (совпадений в них: ${count})`,
  },
  activities: {
    title: "Активности",
    charts: "Статистика",
    allActivities: "Активности",
    allActivitiesTitle: "Выбор активностей",
    dateButton: "Дата",
    todayShort: "Сегодня",
    poolListTitle: "Добавить новую активность",
    addActivity: "Добавить",
    addActivityLong: "Добавить активность",
    addPlaceholder: "Название активности",
    selectTodayTitle: "Отметить на сегодня",
    empty: "Нет активностей. Добавьте первую.",
    emptyToday: "Ничего не отмечено на сегодня",
    statsTitle: "Статистика по активностям",
    searchPlaceholder: "Поиск по активностям",
    searchNoResults: "Ничего не найдено",
    currentMonth: "Текущий месяц",
  },
} as const;
