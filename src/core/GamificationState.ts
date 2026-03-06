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
  shop?: { name: string; cost: number; description?: string }[];
}

function defaultState(): GamificationState {
  return {
    xp: 0,
    gold: 0,
    processedTaskPaths: [],
    processedTasks: [],
    streaks: {},
    purchaseHistory: [],
    shop: [],
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
}

/** Элемент пула активностей (Logbook). */
export interface ActivityItem {
  id: string;
  name: string;
}

/** Данные пула активностей: список, история по датам (activityId -> dateKey -> количество выполнений), награды. */
export interface ActivitiesData {
  items: ActivityItem[];
  /** activityId -> dateKey (YYYY-MM-DD) -> количество раз за день */
  history: Record<string, Record<string, number>>;
  /** activityId -> dateKey -> сколько раз уже начислена награда за этот день (можно несколько за день). */
  rewardsGiven?: Record<string, Record<string, number>>;
}

/** Префикс в корзине для записей, удалённых из архива блокнота (выполненные). */
export const INBOX_ARCHIVE_TRASH_PREFIX = "[Выполнено] ";

export function isInboxArchiveTrashEntry(line: string): boolean {
  return typeof line === "string" && line.trim().startsWith(INBOX_ARCHIVE_TRASH_PREFIX);
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
  trash?: string[];
  inboxArchive?: InboxArchiveItem[];
  activities?: ActivitiesData;
}

export interface DataStorage {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export async function readDataFile(storage: DataStorage): Promise<PluginDataFile> {
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
      gamification: gamification as GamificationState | undefined,
      projects: Array.isArray(data.projects) ? (data.projects as string[]) : [],
      reminders: Array.isArray(data.reminders) ? (data.reminders as string[]) : [],
      inbox: Array.isArray(data.inbox) ? (data.inbox as string[]) : [],
      trash: Array.isArray(data.trash) ? (data.trash as string[]) : [],
      inboxArchive,
      activities: parseActivitiesData(data.activities),
    };
  } catch {
    return { projects: [], reminders: [], inbox: [], trash: [], inboxArchive: [], activities: { items: [], history: {} } };
  }
}

function parseActivitiesData(raw: unknown): ActivitiesData {
  if (!raw || typeof raw !== "object") return { items: [], history: {} };
  const d = raw as Record<string, unknown>;
  const items: ActivityItem[] = Array.isArray(d.items)
    ? (d.items as unknown[]).filter(
        (x): x is ActivityItem =>
          typeof x === "object" && x !== null && "id" in x && "name" in x && typeof (x as ActivityItem).id === "string" && typeof (x as ActivityItem).name === "string"
      )
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
            byDate[dateKey] = count;
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
            byDate[dateKey] = num;
          }
        }
        if (Object.keys(byDate).length) rewardsGiven[k] = byDate;
      }
    }
  }
  return { items, history, rewardsGiven: Object.keys(rewardsGiven).length ? rewardsGiven : undefined };
}

export async function writeDataFile(storage: DataStorage, payload: PluginDataFile): Promise<void> {
  const data = ((await storage.loadData()) as Record<string, unknown>) || {};
  const merged = { ...data, ...payload };
  await storage.saveData(merged);
}

function parseStateFromRaw(data: unknown): GamificationState {
  if (!data || typeof data !== "object") return defaultState();
  const d = data as Record<string, unknown>;
  const processedTasks = Array.isArray(d.processedTasks)
    ? (d.processedTasks as { path: string; completedAt?: string | null; taskName?: string; deadline?: string; rewardXp?: number; rewardGold?: number; rewardMessage?: string }[]).map((t) => ({
        path: t.path,
        completedAt: t.completedAt ?? null,
        taskName: t.taskName,
        deadline: t.deadline,
        rewardXp: t.rewardXp,
        rewardGold: t.rewardGold,
        rewardMessage: t.rewardMessage,
      }))
    : Array.isArray(d.processedTaskPaths)
      ? (d.processedTaskPaths as string[]).map((p) => ({ path: p, completedAt: null }))
      : [];
  const rawHistory = Array.isArray(d.purchaseHistory) ? d.purchaseHistory : [];
  const purchaseHistory = rawHistory.map((h: string | PurchaseRecord) =>
    typeof h === "string" ? { purchasedAt: new Date().toISOString(), name: h, cost: 0 } : h
  );
  const rawStreaks = d.streaks && typeof d.streaks === "object" ? d.streaks : {};
  const streaks: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawStreaks)) {
    const key = typeof k === "string" ? k : String(k ?? "");
    const num = typeof v === "number" && !isNaN(v) ? v : 0;
    streaks[key] = num;
  }
  return {
    ...defaultState(),
    ...d,
    processedTaskPaths: processedTasks.map((t) => t.path),
    processedTasks,
    streaks,
    purchaseHistory,
    shop: Array.isArray(d.shop) ? d.shop : [],
  } as GamificationState;
}

export async function readState(storage: DataStorage): Promise<GamificationState> {
  try {
    const data = (await storage.loadData()) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return defaultState();

    const hasWrapper = "gamification" in data;
    const hasLegacyState = "xp" in data;
    return parseStateFromRaw(hasWrapper ? data.gamification : hasLegacyState ? data : undefined);
  } catch {
    return defaultState();
  }
}

export async function writeState(storage: DataStorage, state: GamificationState): Promise<void> {
  const data = ((await storage.loadData()) as Record<string, unknown>) || {};
  data.gamification = state;
  await storage.saveData(data);
}

export function getRewardForDifficulty(
  difficulty: string | null | undefined,
  config?: Pick<GamificationDefaults, "difficultyRewards" | "defaultDifficulty">
): { xp: number; gold: number } {
  const rewards = config?.difficultyRewards ?? DIFFICULTY_REWARDS_DEFAULT;
  const fallback = config?.defaultDifficulty ?? DEFAULT_DIFFICULTY_FALLBACK;
  const key = (difficulty ?? "").toLowerCase().trim();
  return rewards[key] ?? rewards[fallback] ?? { xp: 5, gold: 2 };
}
