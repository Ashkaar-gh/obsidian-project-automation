import { REMINDER_DATE_TAG_REGEX } from "./ReminderDataUtils";
import { normalizeInboxLink, pruneTrashMeta, type InboxLink, type TrashEntryMeta } from "./InboxEntries";

const XP_LEVEL_BASE_DEFAULT = 20;

export const DIFFICULTY_REWARDS_DEFAULT: Record<string, { xp: number; gold: number }> = {
  легкая: { xp: 5, gold: 2 },
  средняя: { xp: 10, gold: 5 },
  сложная: { xp: 20, gold: 10 },
};
const DEFAULT_DIFFICULTY_FALLBACK = "легкая";

export type ShopItem = { name: string; cost: number; description?: string };

export interface GamificationDefaults {
  xpLevelBase: number;
  difficultyRewards: Record<string, { xp: number; gold: number }>;
  defaultDifficulty: string;
  defaultShop?: ShopItem[];
}

export const DEFAULT_GAMIFICATION_DEFAULTS: GamificationDefaults = {
  xpLevelBase: XP_LEVEL_BASE_DEFAULT,
  difficultyRewards: { ...DIFFICULTY_REWARDS_DEFAULT },
  defaultDifficulty: DEFAULT_DIFFICULTY_FALLBACK,
  defaultShop: [],
};

export interface ProcessedTask {
  path: string;
  completedAt: string | null;
  taskName?: string;
  deadline?: string;
  rewardXp?: number;
  rewardGold?: number;
  rewardMessage?: string;
}

export interface PurchaseRecord {
  purchasedAt: string;
  name: string;
  description?: string;
  cost: number;
}

export interface GamificationState {
  xp: number;
  gold: number;
  processedTaskPaths: string[];
  processedTasks: ProcessedTask[];
  streaks: Record<string, number>;
  purchaseHistory: (string | PurchaseRecord)[];
  /**
   * Товары магазина. undefined - магазин ещё ни разу не сохранялся: тогда он заполняется товарами
   * из defaults.json. Пустой массив - пользователь сам удалил все товары, заново не заполняем.
   */
  shop?: ShopItem[];
}

/** Пустое состояние геймификации (для нового data.json и как основа при первом начислении). */
export function emptyGamificationState(): GamificationState {
  return {
    xp: 0,
    gold: 0,
    processedTaskPaths: [],
    processedTasks: [],
    streaks: {},
    purchaseHistory: [],
  };
}

const defaultState = emptyGamificationState;

function nonNegativeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseShopItem(value: unknown): ShopItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== "string" || !item.name.trim()) return null;
  if (typeof item.cost !== "number" || !Number.isFinite(item.cost) || item.cost < 0) return null;
  const description = optionalString(item.description);
  return { name: item.name, cost: item.cost, ...(description !== undefined && { description }) };
}

function parsePurchase(value: unknown): string | PurchaseRecord | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const purchase = value as Record<string, unknown>;
  if (typeof purchase.purchasedAt !== "string" || typeof purchase.name !== "string") return null;
  if (typeof purchase.cost !== "number" || !Number.isFinite(purchase.cost) || purchase.cost < 0) return null;
  const description = optionalString(purchase.description);
  return {
    purchasedAt: purchase.purchasedAt,
    name: purchase.name,
    cost: purchase.cost,
    ...(description !== undefined && { description }),
  };
}

function parseProcessedTask(value: unknown): ProcessedTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  if (typeof task.path !== "string" || !task.path) return null;
  const completedAt = task.completedAt === null || typeof task.completedAt === "string" ? task.completedAt : null;
  const rewardXp = typeof task.rewardXp === "number" && Number.isFinite(task.rewardXp) ? task.rewardXp : undefined;
  const rewardGold = typeof task.rewardGold === "number" && Number.isFinite(task.rewardGold) ? task.rewardGold : undefined;
  return {
    path: task.path,
    completedAt,
    ...(optionalString(task.taskName) !== undefined && { taskName: task.taskName as string }),
    ...(optionalString(task.deadline) !== undefined && { deadline: task.deadline as string }),
    ...(rewardXp !== undefined && { rewardXp }),
    ...(rewardGold !== undefined && { rewardGold }),
    ...(optionalString(task.rewardMessage) !== undefined && { rewardMessage: task.rewardMessage as string }),
  };
}

export function getLevel(xp: number, xpLevelBase: number = XP_LEVEL_BASE_DEFAULT): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / xpLevelBase)) + 1;
}

export function getXpForLevel(level: number, xpLevelBase: number = XP_LEVEL_BASE_DEFAULT): number {
  return Math.pow(level - 1, 2) * xpLevelBase;
}

export function getXpInCurrentLevel(xp: number, xpLevelBase?: number): number {
  return Math.max(0, xp - getXpForLevel(getLevel(xp, xpLevelBase), xpLevelBase));
}

export function getXpPerLevel(xp: number, xpLevelBase?: number): number {
  const lvl = getLevel(xp, xpLevelBase);
  const base = xpLevelBase ?? XP_LEVEL_BASE_DEFAULT;
  return getXpForLevel(lvl + 1, base) - getXpForLevel(lvl, base);
}

export function getRank(level: number): { name: string; icon: string } {
  if (level >= 20) return { name: "Мастер", icon: "👑" };
  if (level >= 10) return { name: "Специалист", icon: "🥈" };
  if (level >= 5) return { name: "Ученик", icon: "🥉" };
  return { name: "Новичок", icon: "🌱" };
}

export interface InboxArchiveItem {
  text: string;
  completedAt: string;
  /** Когда запись попала в блокнот (у старых записей нет). */
  createdAt?: string;
  /** К чему относилась запись (задача или проект), когда её отправили в архив. */
  link?: InboxLink;
}

const ACTIVITY_DIFFICULTY_OPTIONS = ["легкая", "средняя", "сложная"] as const;
export type ActivityDifficulty = (typeof ACTIVITY_DIFFICULTY_OPTIONS)[number];

/** Отображаемые подписи сложности (с заглавной буквы). */
export const DIFFICULTY_DISPLAY_LABELS: Record<ActivityDifficulty, string> = {
  легкая: "Легко",
  средняя: "Средне",
  сложная: "Сложно",
};

export function isActivityDifficulty(s: string): s is ActivityDifficulty {
  return ACTIVITY_DIFFICULTY_OPTIONS.includes(s as ActivityDifficulty);
}

/** Элемент пула активностей (Logbook). */
export interface ActivityItem {
  id: string;
  name: string;
  /** Сложность для награды (легкая / средняя / сложная). */
  difficulty?: ActivityDifficulty;
}

/** Награды по сложности для активностей (дефолт, если в настройках не задано). */
export const ACTIVITY_DIFFICULTY_REWARDS_DEFAULT: Record<ActivityDifficulty, { xp: number; gold: number }> = {
  легкая: { xp: 2, gold: 1 },
  средняя: { xp: 5, gold: 2 },
  сложная: { xp: 10, gold: 5 },
};

/** Данные пула активностей: список, история по датам (activityId -> dateKey -> количество выполнений), награды. */
export interface ActivitiesData {
  items: ActivityItem[];
  /** activityId -> dateKey (YYYY-MM-DD) -> количество раз за день */
  history: Record<string, Record<string, number>>;
  /** activityId -> dateKey -> сколько раз уже начислена награда за этот день (можно несколько за день). */
  rewardsGiven?: Record<string, Record<string, number>>;
}

/**
 * Префикс в корзине для записей, удалённых из архива блокнота (разобранные). Текст префикса не меняется
 * вместе с подписью кнопки: по нему узнаются уже лежащие в корзине записи.
 */
export const INBOX_ARCHIVE_TRASH_PREFIX = "[Выполнено] ";

export function isInboxArchiveTrashEntry(line: string): boolean {
  return typeof line === "string" && line.trim().startsWith(INBOX_ARCHIVE_TRASH_PREFIX);
}

/**
 * Удалённое напоминание в корзине: строка «- [ ] текст (@дата)» (или [x], или «*» вместо «-»).
 * Такие строки показываются простым текстом, как раньше; всё остальное в корзине - записи блокнота (markdown).
 */
export function isReminderTrashEntry(line: string): boolean {
  return typeof line === "string" && /^\s*[-*]\s+\[[ xX]\]\s/.test(line) && REMINDER_DATE_TAG_REGEX.test(line);
}

/** Текст записи блокнота из корзины для markdown: как есть, у разобранной записи - без пометки архива. */
export function getTrashEntryMarkdown(line: string): string {
  const text = typeof line === "string" ? line : "";
  const start = text.replace(/^\s+/, "");
  return start.startsWith(INBOX_ARCHIVE_TRASH_PREFIX) ? start.slice(INBOX_ARCHIVE_TRASH_PREFIX.length) : text;
}

export function getTrashDisplayText(line: string): string {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (trimmed.startsWith(INBOX_ARCHIVE_TRASH_PREFIX)) {
    return trimmed.slice(INBOX_ARCHIVE_TRASH_PREFIX.length).trim();
  }
  return trimmed.replace(/^[-*]\s+(\[[xX\s]\]\s+)?/, "");
}

export interface PluginDataFile {
  gamification?: GamificationState;
  projects?: string[];
  reminders?: string[];
  inbox?: string[];
  /** Время создания записей блокнота: текст записи → ISO. Отдельно от inbox, чтобы inbox оставался массивом строк. */
  inboxCreatedAt?: Record<string, string>;
  /** К чему относятся записи блокнота: текст записи → задача или проект. Отдельно от inbox, как и время. */
  inboxLinks?: Record<string, InboxLink>;
  trash?: string[];
  /** Записи блокнота в корзине: строка корзины → когда записана и к чему относилась. Отдельно от trash, как и время. */
  trashMeta?: Record<string, TrashEntryMeta>;
  inboxArchive?: InboxArchiveItem[];
  activities?: ActivitiesData;
  reminderRewardIds?: string[];
  /** Записи из старого Inbox.md уже перенесены в data.json (перенос выполняется один раз). */
  inboxMigrated?: boolean;
}

export interface DataStorage {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

/**
 * Очередь записи data.json: все мутации выполняются последовательно,
 * иначе конкурентные read-modify-write теряют данные (двойные награды, пропавшие записи).
 */
const writeQueues = new WeakMap<DataStorage, Promise<unknown>>();

function enqueueWrite<T>(storage: DataStorage, job: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(storage) ?? Promise.resolve();
  const next = prev.then(job, job);
  writeQueues.set(
    storage,
    next.catch(() => undefined)
  );
  return next;
}

/**
 * Атомарное изменение data.json: читает актуальные данные, применяет мутатор
 * и сохраняет результат - всё внутри очереди записи.
 * Мутатор возвращает патч (изменённые поля) или мутирует данные и возвращает void.
 */
export function updateDataFile(
  storage: DataStorage,
  mutator: (data: PluginDataFile) => Partial<PluginDataFile> | void
): Promise<void> {
  return enqueueWrite(storage, async () => {
    const data = await readDataFileUnsafe(storage, false);
    const patch = mutator(data) ?? data;
    await mergeAndSave(storage, patch as Record<string, unknown>);
  });
}

async function mergeAndSave(storage: DataStorage, payload: Record<string, unknown>): Promise<void> {
  const raw = ((await storage.loadData()) as Record<string, unknown>) || {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) cleaned[key] = value;
  }
  await storage.saveData({ ...raw, ...cleaned });
}

export async function readDataFile(storage: DataStorage): Promise<PluginDataFile> {
  return readDataFileUnsafe(storage);
}

/** Чтение без очереди (внутри очереди используется напрямую). */
async function readDataFileUnsafe(storage: DataStorage, suppressErrors = true): Promise<PluginDataFile> {
  try {
    const data = (await storage.loadData()) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return { projects: [], reminders: [], inbox: [], trash: [], inboxArchive: [], activities: { items: [], history: {} } };

    const hasWrapper = "gamification" in data;
    const hasLegacyState = "xp" in data;
    const gamification = hasWrapper ? data.gamification : hasLegacyState ? data : undefined;

    const rawArchive = data.inboxArchive;
    const inboxArchive: InboxArchiveItem[] = Array.isArray(rawArchive)
      ? (rawArchive as unknown[]).filter(
          (x): x is InboxArchiveItem =>
            typeof x === "object" && x !== null && "text" in x && "completedAt" in x && typeof (x as InboxArchiveItem).text === "string" && typeof (x as InboxArchiveItem).completedAt === "string"
        )
      : [];

    return {
      gamification: gamification === undefined ? undefined : normalizeGamificationState(gamification),
      projects: stringArray(data.projects),
      reminders: stringArray(data.reminders),
      inbox: stringArray(data.inbox),
      ...(isPlainObject(data.inboxCreatedAt) && { inboxCreatedAt: stringRecord(data.inboxCreatedAt) }),
      ...(isPlainObject(data.inboxLinks) && { inboxLinks: linkRecord(data.inboxLinks) }),
      trash: stringArray(data.trash),
      ...(isPlainObject(data.trashMeta) && { trashMeta: pruneTrashMeta(data.trashMeta, stringArray(data.trash)) }),
      inboxArchive,
      activities: parseActivitiesData(data.activities),
      reminderRewardIds: stringArray(data.reminderRewardIds),
      ...(data.inboxMigrated === true && { inboxMigrated: true }),
    };
  } catch (error) {
    if (!suppressErrors) throw error;
    return { projects: [], reminders: [], inbox: [], trash: [], inboxArchive: [], activities: { items: [], history: {} } };
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

/** Привязки записей блокнота: только корректные (задача или проект). */
function linkRecord(value: Record<string, unknown>): Record<string, InboxLink> {
  const out: Record<string, InboxLink> = {};
  for (const [key, item] of Object.entries(value)) {
    const link = normalizeInboxLink(item);
    if (link) out[key] = link;
  }
  return out;
}

function parseActivityItem(x: unknown): ActivityItem | null {
  if (typeof x !== "object" || x === null || !("id" in x) || !("name" in x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.name !== "string") return null;
  const difficulty =
    typeof o.difficulty === "string" && isActivityDifficulty(o.difficulty) ? o.difficulty : undefined;
  return { id: o.id, name: o.name, ...(difficulty && { difficulty }) };
}

function parseActivitiesData(raw: unknown): ActivitiesData {
  if (!raw || typeof raw !== "object") return { items: [], history: {} };
  const d = raw as Record<string, unknown>;
  const items: ActivityItem[] = Array.isArray(d.items)
    ? (d.items as unknown[]).map(parseActivityItem).filter((x): x is ActivityItem => x !== null)
    : [];
  const hist = d.history;
  const history: Record<string, Record<string, number>> = {};
  if (hist && typeof hist === "object" && !Array.isArray(hist)) {
    for (const [k, v] of Object.entries(hist)) {
      if (typeof k !== "string") continue;
      if (Array.isArray(v)) {
        const byDate: Record<string, number> = {};
        for (const dateKey of (v as unknown[])) {
          if (typeof dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
            byDate[dateKey] = (byDate[dateKey] ?? 0) + 1;
          }
        }
        if (Object.keys(byDate).length) history[k] = byDate;
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        const byDate: Record<string, number> = {};
        for (const [dateKey, count] of Object.entries(v)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey) && typeof count === "number" && count > 0) {
            byDate[dateKey] = Math.floor(count);
          }
        }
        if (Object.keys(byDate).length) history[k] = byDate;
      }
    }
  }
  const rg = d.rewardsGiven;
  const rewardsGiven: Record<string, Record<string, number>> = {};
  if (rg && typeof rg === "object" && !Array.isArray(rg)) {
    for (const [k, v] of Object.entries(rg)) {
      if (typeof k !== "string") continue;
      if (Array.isArray(v)) {
        const byDate: Record<string, number> = {};
        for (const dateKey of v as unknown[]) {
          if (typeof dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
            byDate[dateKey] = 1;
          }
        }
        if (Object.keys(byDate).length) rewardsGiven[k] = byDate;
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        const byDate: Record<string, number> = {};
        for (const [dateKey, num] of Object.entries(v)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey) && typeof num === "number" && num >= 0) {
            byDate[dateKey] = Math.floor(num);
          }
        }
        if (Object.keys(byDate).length) rewardsGiven[k] = byDate;
      }
    }
  }
  return { items, history, rewardsGiven: Object.keys(rewardsGiven).length ? rewardsGiven : undefined };
}

/** Записать поля в data.json (через очередь), не трогая остальные ключи. */
export function writeDataFile(
  storage: DataStorage,
  payload: Partial<PluginDataFile> | Record<string, unknown>
): Promise<void> {
  return enqueueWrite(storage, () => mergeAndSave(storage, payload as Record<string, unknown>));
}

export function normalizeGamificationState(data: unknown): GamificationState {
  if (!data || typeof data !== "object") return defaultState();
  const d = data as Record<string, unknown>;
  const taskByPath = new Map<string, ProcessedTask>();
  if (Array.isArray(d.processedTasks)) {
    for (const rawTask of d.processedTasks) {
      const task = parseProcessedTask(rawTask);
      if (task) taskByPath.set(task.path, task);
    }
  }
  for (const path of stringArray(d.processedTaskPaths)) {
    if (path && !taskByPath.has(path)) taskByPath.set(path, { path, completedAt: null });
  }
  const processedTasks = [...taskByPath.values()];
  const rawHistory = Array.isArray(d.purchaseHistory) ? d.purchaseHistory : [];
  const purchaseHistory = rawHistory.map(parsePurchase).filter((item): item is string | PurchaseRecord => item !== null);
  const rawStreaks = d.streaks && typeof d.streaks === "object" && !Array.isArray(d.streaks) ? d.streaks : {};
  const streaks: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawStreaks)) {
    if (k && typeof v === "number" && Number.isFinite(v) && v >= 0) streaks[k] = v;
  }
  return {
    xp: nonNegativeNumber(d.xp),
    gold: nonNegativeNumber(d.gold),
    processedTaskPaths: processedTasks.map((t) => t.path),
    processedTasks,
    streaks,
    purchaseHistory,
    ...(Array.isArray(d.shop) && {
      shop: d.shop.map(parseShopItem).filter((item): item is ShopItem => item !== null),
    }),
  };
}

export async function readState(storage: DataStorage): Promise<GamificationState> {
  try {
    const data = (await storage.loadData()) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return defaultState();

    const hasWrapper = "gamification" in data;
    const hasLegacyState = "xp" in data;
    return normalizeGamificationState(hasWrapper ? data.gamification : hasLegacyState ? data : undefined);
  } catch {
    return defaultState();
  }
}

/**
 * Другие написания сложности → ключ таблицы наград.
 * Форма «Создать задачу» пишет во frontmatter «Легко / Средне / Сложно», настройки и таблица наград
 * используют «легкая / средняя / сложная»; раньше из-за этого награда всегда падала на сложность по умолчанию.
 */
const DIFFICULTY_SYNONYMS: Record<string, string> = {
  легко: "легкая",
  легкий: "легкая",
  легкое: "легкая",
  простая: "легкая",
  просто: "легкая",
  easy: "легкая",
  low: "легкая",
  средне: "средняя",
  средний: "средняя",
  среднее: "средняя",
  medium: "средняя",
  normal: "средняя",
  сложно: "сложная",
  сложный: "сложная",
  сложное: "сложная",
  тяжелая: "сложная",
  тяжело: "сложная",
  тяжелый: "сложная",
  трудная: "сложная",
  трудно: "сложная",
  hard: "сложная",
  high: "сложная",
};

/** Ключ сложности для таблицы наград: нижний регистр, без «ё», известные синонимы приводятся к «легкая / средняя / сложная». */
export function normalizeDifficultyKey(difficulty: string | null | undefined): string {
  const key = (difficulty ?? "").toLowerCase().replace(/ё/g, "е").trim();
  return DIFFICULTY_SYNONYMS[key] ?? key;
}

export function getRewardForDifficulty(
  difficulty: string | null | undefined,
  config?: Pick<GamificationDefaults, "difficultyRewards" | "defaultDifficulty">
): { xp: number; gold: number } {
  const rewards = config?.difficultyRewards ?? DIFFICULTY_REWARDS_DEFAULT;
  const fallback = config?.defaultDifficulty ?? DEFAULT_DIFFICULTY_FALLBACK;
  const raw = (difficulty ?? "").toLowerCase().trim();
  // Сначала точный ключ (в data.json могут быть свои названия сложностей), затем приведённый синоним.
  return rewards[raw] ?? rewards[normalizeDifficultyKey(raw)] ?? rewards[fallback] ?? { xp: 5, gold: 2 };
}
