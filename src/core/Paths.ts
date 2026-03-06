/** Единый источник путей (Inbox, Trash, daily, templates, archive, homepage, reminders). */

export const INBOX_FILE = "Inbox.md";
export const TRASH_FILE = "Trash.md";
export const DAILY_FOLDER = "periodic/daily";
export const TEMPLATES_FOLDER = "templates";
export const ARCHIVE_FOLDER = "Archive";
export const TASK_TEMPLATE_PATH = "templates/task.md";
/** Каталог с нестандартными шаблонами задач: каждый .md — один тип в выборе «Создать задачу». */
export const TASK_TEMPLATES_FOLDER = "templates/task-templates";
export const PROJECT_TEMPLATE_PATH = "templates/project.md";
export const DAILY_TEMPLATE_PATH = "templates/daily.md";
export const HOMEPAGE_FILE = "Homepage.md";
export const REMINDERS_FILE = "Reminders.md";

export const Paths = {
  INBOX_FILE,
  TRASH_FILE,
  DAILY_FOLDER,
  TEMPLATES_FOLDER,
  ARCHIVE_FOLDER,
  TASK_TEMPLATE_PATH,
  TASK_TEMPLATES_FOLDER,
  PROJECT_TEMPLATE_PATH,
  DAILY_TEMPLATE_PATH,
  HOMEPAGE_FILE,
  REMINDERS_FILE,
} as const;
