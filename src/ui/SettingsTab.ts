/** Вкладка настроек плагина. */

import { App, PluginSettingTab, Setting } from "obsidian";
import type { ObsidianProjectAutomationPlugin } from "../main";
import {
  ACTIVITY_DIFFICULTY_REWARDS_DEFAULT,
  DIFFICULTY_DISPLAY_LABELS,
  DIFFICULTY_REWARDS_DEFAULT,
} from "../core/GamificationState";

type Reward = { xp: number; gold: number };
type DifficultyKey = "легкая" | "средняя" | "сложная";

const DIFFICULTY_KEYS: DifficultyKey[] = ["легкая", "средняя", "сложная"];
const XP_GOLD_HINT = " Первое поле - XP, второе - Gold.";

export class ObsidianProjectAutomationSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ObsidianProjectAutomationPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian Project Automation" });

    new Setting(containerEl).setName("Проекты и задачи");
    const projectsWrap = containerEl.createDiv({ cls: "opa-settings-projects-wrap opa-settings-indent" });

    // Перечитываем data.json при открытии вкладки, чтобы в форме отображались актуальные contextOptions/environmentOptions
    this.plugin.loadSettings().then(() => this.renderSettingsForm(containerEl, projectsWrap));
  }

  /** Сохранить настройки и обновить блоки геймификации. */
  private saveAndRefreshGamification = async (): Promise<void> => {
    await this.plugin.saveSettings();
    this.plugin.gamification?.updateState?.();
  };

  /** Пара текстовых полей XP/Gold с валидацией неотрицательного числа. */
  private addXpGoldSetting(
    parent: HTMLElement,
    name: string,
    desc: string,
    get: () => Reward,
    set: (value: Reward) => void
  ): void {
    const current = get();
    const onChangeFor = (field: keyof Reward) => async (v: string) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0) return;
      set({ ...get(), [field]: n });
      await this.saveAndRefreshGamification();
    };
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addText((t) => t.setPlaceholder("XP").setValue(String(current.xp)).onChange(onChangeFor("xp")))
      .addText((t) => t.setPlaceholder("Gold").setValue(String(current.gold)).onChange(onChangeFor("gold")));
  }

  /** Дропдаун выбора сложности по умолчанию. */
  private addDefaultDifficultySetting(
    parent: HTMLElement,
    desc: string,
    get: () => string,
    set: (value: string) => void
  ): void {
    new Setting(parent)
      .setName("Сложность по умолчанию")
      .setDesc(desc)
      .addDropdown((d) => {
        for (const key of DIFFICULTY_KEYS) d.addOption(key, DIFFICULTY_DISPLAY_LABELS[key]);
        d.setValue(get()).onChange(async (v) => {
          set(v);
          await this.saveAndRefreshGamification();
        });
      });
  }

  /** Секция «Награды за сложность» (задачи или активности). */
  private renderDifficultyRewardsSection(
    parent: HTMLElement,
    options: {
      title: string;
      subject: string;
      defaults: Record<string, Reward>;
      getRewards: () => Record<string, Reward> | undefined;
      setRewards: (value: Record<string, Reward>) => void;
      getDefaultDifficulty: () => string;
      setDefaultDifficulty: (value: string) => void;
    }
  ): void {
    const section = parent.createDiv({ cls: "opa-settings-gamification-section" });
    section.createEl("div", { cls: "opa-settings-section-title", text: options.title });
    this.addDefaultDifficultySetting(
      section,
      `Если у ${options.subject} не указана сложность`,
      options.getDefaultDifficulty,
      options.setDefaultDifficulty
    );
    const descByKey: Record<DifficultyKey, string> = {
      легкая: `XP и Gold за выполнение ${options.subject} легкой сложности.${XP_GOLD_HINT}`,
      средняя: `XP и Gold за выполнение ${options.subject} средней сложности.${XP_GOLD_HINT}`,
      сложная: `XP и Gold за выполнение ${options.subject} тяжелой сложности.${XP_GOLD_HINT}`,
    };
    for (const key of DIFFICULTY_KEYS) {
      this.addXpGoldSetting(
        section,
        `Награда: ${DIFFICULTY_DISPLAY_LABELS[key]}`,
        descByKey[key],
        () => options.getRewards()?.[key] ?? { xp: 0, gold: 0 },
        (value) => {
          const rewards = { ...(options.getRewards() ?? options.defaults) };
          rewards[key] = value;
          options.setRewards(rewards);
        }
      );
    }
  }

  /** Тумблер включения модуля. */
  private addModuleToggle(
    parent: HTMLElement,
    name: string,
    get: () => boolean,
    onChanged: (value: boolean) => Promise<void> | void
  ): void {
    new Setting(parent).setName(name).addToggle((t) =>
      t.setValue(get()).onChange(async (v) => {
        await onChanged(v);
      })
    );
  }

  /** Числовое поле с валидацией (n >= min). */
  private addNumberSetting(
    parent: HTMLElement,
    name: string,
    desc: string,
    placeholder: string,
    min: number,
    get: () => number,
    set: (value: number) => void
  ): void {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addText((t) =>
        t
          .setPlaceholder(placeholder)
          .setValue(String(get()))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < min) return;
            set(n);
            await this.saveAndRefreshGamification();
          })
      );
  }

  private renderSettingsForm(containerEl: HTMLElement, projectsWrap: HTMLElement): void {
    const { settings } = this.plugin;

    new Setting(projectsWrap)
      .setName("Окружения")
      .setDesc("Варианты окружения через запятую (например: prod, dev)")
      .addText((t) =>
        t
          .setPlaceholder("prod, dev")
          .setValue(settings.environmentOptions ?? "")
          .onChange(async (v) => {
            settings.environmentOptions = v;
            await this.plugin.saveSettings();
          })
      );
    new Setting(projectsWrap)
      .setName("Контексты")
      .setDesc("Варианты контекста через запятую (например: личное, работа)")
      .addText((t) =>
        t
          .setPlaceholder("личное, работа")
          .setValue(settings.contextOptions ?? "")
          .onChange(async (v) => {
            settings.contextOptions = v;
            await this.plugin.saveSettings();
          })
      );
    new Setting(projectsWrap)
      .setName("Пример шаблона задачи")
      .setDesc("Создать файл templates/task-templates/task-example.md с примером шаблона")
      .addButton((btn) =>
        btn.setButtonText("Создать пример").onClick(() => this.plugin.noteTemplates?.createExampleTaskTemplate())
      );
    new Setting(projectsWrap)
      .setName("Дедлайн")
      .setDesc("Показывать поле дедлайн в проектах и доске задач")
      .addToggle((t) =>
        t.setValue(settings.enableDeadline ?? false).onChange(async (v) => {
          settings.enableDeadline = v;
          await this.plugin.saveSettings();
          this.plugin.tasksDashboard?.scheduleRefresh();
          this.display();
        })
      );
    if (settings.enableDeadline) {
      const deadlineWrap = projectsWrap.createDiv({ cls: "opa-settings-deadline-wrap opa-settings-indent" });
      new Setting(deadlineWrap)
        .setName("Напоминание для дедлайна")
        .setDesc("При создании задачи с дедлайном добавлять напоминание")
        .addToggle((t) =>
          t.setValue(settings.enableDeadlineReminders ?? true).onChange(async (v) => {
            settings.enableDeadlineReminders = v;
            await this.plugin.saveSettings();
          })
        );
      const leadDaysSetting = new Setting(deadlineWrap)
        .setName("За сколько дней напоминать")
        .setDesc("За сколько дней до дедлайна срабатывает напоминание (0 — в день дедлайна)")
        .addText((t) =>
          t
            .setPlaceholder("1")
            .setValue(String(settings.deadlineReminderLeadDays ?? 1))
            .onChange(async (v) => {
              const n = parseInt(v, 10);
              if (!Number.isNaN(n) && n >= 0) {
                settings.deadlineReminderLeadDays = n;
                await this.plugin.saveSettings();
              }
            })
        );
      leadDaysSetting.controlEl.addClass("opa-settings-lead-days");
    }

    new Setting(projectsWrap)
      .setName("Комментарий при смене статуса задачи")
      .setDesc("При смене статуса задачи предлагать указать причину (добавляется в раздел \"Описание задачи\")")
      .addToggle((t) =>
        t.setValue(settings.enableStatusChangeComment ?? false).onChange(async (v) => {
          settings.enableStatusChangeComment = v;
          await this.plugin.saveSettings();
        })
      );

    this.addModuleToggle(containerEl, "Доска задач", () => settings.enableTasksDashboard, async (v) => {
      settings.enableTasksDashboard = v;
      await this.plugin.saveSettings();
      this.plugin.tasksDashboard?.updateState?.();
    });

    this.addModuleToggle(containerEl, "Напоминания", () => settings.enableReminders, async (v) => {
      settings.enableReminders = v;
      settings.enableTrash = settings.enableInbox || settings.enableReminders;
      await this.plugin.saveSettings();
      this.plugin.reminders?.updateState?.();
      this.plugin.trash?.updateState?.();
      this.plugin.inbox?.updateState?.();
    });

    this.addModuleToggle(containerEl, "Блокнот", () => settings.enableInbox, async (v) => {
      settings.enableInbox = v;
      settings.enableTrash = settings.enableInbox || settings.enableReminders;
      await this.plugin.saveSettings();
      this.plugin.inbox?.updateState?.();
      this.plugin.trash?.updateState?.();
    });

    this.addModuleToggle(containerEl, "Активности", () => settings.enableActivities ?? true, async (v) => {
      settings.enableActivities = v;
      await this.plugin.saveSettings();
      this.plugin.activities?.updateState?.();
    });

    this.addModuleToggle(containerEl, "Геймификация", () => settings.enableGamification, async (v) => {
      settings.enableGamification = v;
      await this.plugin.saveSettings();
      this.plugin.gamification?.updateState?.();
      this.display();
    });

    if (settings.enableGamification) {
      const gamificationWrap = containerEl.createDiv({ cls: "opa-settings-gamification-wrap opa-settings-indent" });

      this.addNumberSetting(
        gamificationWrap,
        "Базовый XP за уровень",
        "Определяет, как быстро растёт уровень от накопленного XP: уровень = 1 + √(суммарный XP ÷ базовый XP). Чем больше число, тем медленнее рост уровня.",
        "20",
        1,
        () => settings.gamificationXpLevelBase ?? 20,
        (n) => (settings.gamificationXpLevelBase = n)
      );
      this.addNumberSetting(
        gamificationWrap,
        "Грейс-период для стрика (дней)",
        "Дополнительные дни после срока повторения, в которые выполнение ещё сохраняет стрик. 0 = в течение суток (до конца следующего дня по шагу повторения).",
        "0",
        0,
        () => settings.gamificationStreakGraceDays ?? 0,
        (n) => (settings.gamificationStreakGraceDays = n)
      );

      this.renderDifficultyRewardsSection(gamificationWrap, {
        title: "Награды за сложность (задачи)",
        subject: "задачи",
        defaults: DIFFICULTY_REWARDS_DEFAULT,
        getRewards: () => settings.gamificationDifficultyRewards,
        setRewards: (v) => (settings.gamificationDifficultyRewards = v),
        getDefaultDifficulty: () => settings.gamificationDefaultDifficulty ?? "легкая",
        setDefaultDifficulty: (v) => (settings.gamificationDefaultDifficulty = v),
      });

      this.renderDifficultyRewardsSection(gamificationWrap, {
        title: "Награды за сложность (активности)",
        subject: "активности",
        defaults: ACTIVITY_DIFFICULTY_REWARDS_DEFAULT,
        getRewards: () => settings.gamificationActivityDifficultyRewards,
        setRewards: (v) => (settings.gamificationActivityDifficultyRewards = v),
        getDefaultDifficulty: () => settings.gamificationActivityDefaultDifficulty ?? "легкая",
        setDefaultDifficulty: (v) => (settings.gamificationActivityDefaultDifficulty = v),
      });

      const fixedSection = gamificationWrap.createDiv({ cls: "opa-settings-gamification-section" });
      fixedSection.createEl("div", { cls: "opa-settings-section-title", text: "Награды (напоминания и блокнот)" });
      this.addXpGoldSetting(
        fixedSection,
        "Напоминание",
        `XP и Gold за выполнение напоминания.${XP_GOLD_HINT}`,
        () => settings.gamificationReminderRewards ?? { xp: 2, gold: 1 },
        (v) => (settings.gamificationReminderRewards = v)
      );
      this.addXpGoldSetting(
        fixedSection,
        "Блокнот",
        `XP и Gold за выполнение пункта в блокноте (отметка «Сделано»).${XP_GOLD_HINT}`,
        () => settings.gamificationInboxRewards ?? { xp: 5, gold: 2 },
        (v) => (settings.gamificationInboxRewards = v)
      );
    }

    this.addModuleToggle(containerEl, "Refresh", () => settings.enablePluginRefresh, async (v) => {
      settings.enablePluginRefresh = v;
      await this.plugin.saveSettings();
      this.plugin.tasksDashboard?.updateState?.();
    });
  }
}
