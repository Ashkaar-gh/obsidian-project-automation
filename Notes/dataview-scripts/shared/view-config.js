/**
 * Конфигурация статусов задач: ключ, метка, иконка, вес для сортировки.
 * Используется в GTD/project view и везде, где нужны иконки и порядок статусов.
 */
const STATUS_CONFIG = [
    { key: 'в работе', label: 'В работе', icon: '⚙️', weight: 10 },
    { key: 'тестирование', label: 'Тестирование', icon: '🔍', weight: 20 },
    { key: 'повторяющиеся', label: 'Повторяющиеся', icon: '🔁', weight: 30 },
    { key: 'backlog', label: 'Backlog', icon: '🗒️', weight: 40 },
    { key: 'готово', label: 'Готово', icon: '☑️', weight: 90 },
    { key: 'отменено', label: 'Отменено', icon: '🚫', weight: 100 }
];

const DEFAULT_ICON = '❓';
const DEFAULT_WEIGHT = 50;

const REFRESH_DELAY_MS = 500;
const REFRESH_DELAY_MS_FAST = 100;

/** Поиск конфига по частичному совпадению ключа (регистронезависимо). */
function getConfig(statusStr) {
    const s = (statusStr || "").toLowerCase();
    return STATUS_CONFIG.find(c => s.includes(c.key));
}

/** Иконка статуса по строке (частичное совпадение). */
function getIcon(statusStr) {
    const conf = getConfig(statusStr);
    return conf ? conf.icon : DEFAULT_ICON;
}

/** Вес статуса для сортировки. */
function getWeight(statusStr) {
    const conf = getConfig(statusStr);
    return conf ? conf.weight : DEFAULT_WEIGHT;
}

/** Опции для селекта статуса: value, label с иконкой, icon. */
function getDropdownOptions() {
    return STATUS_CONFIG.map(c => ({
        value: c.label,
        label: `${c.label} ${c.icon}`,
        icon: c.icon
    }));
}

return { 
    STATUS_CONFIG, 
    getIcon, 
    getWeight, 
    getDropdownOptions,
    REFRESH_DELAY_MS,
    REFRESH_DELAY_MS_FAST
};