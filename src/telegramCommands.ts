import { Config } from "./config.js";
import { Logger } from "./logger.js";
import { State, resetStats } from "./state.js";
import { TelegramNotifier } from "./telegram.js";
import { sleep } from "./utils.js";

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number | string };
    text?: string;
    date: number;
  };
}

const formatDuration = (fromIso: string): string => {
  const ms = Date.now() - new Date(fromIso).getTime();
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} д`);
  if (hours) parts.push(`${hours} ч`);
  if (!days) parts.push(`${minutes} мин`);
  return parts.join(" ");
};

const reasonLines = (reasons: Record<string, number>): string => {
  const entries = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "  —";
  return entries.map(([reason, count]) => `  • ${reason}: ${count}`).join("\n");
};

/** Builds the human-readable "итог" summary sent back to Telegram. */
export const formatStatsMessage = (state: State, config: Config): string => {
  const s = state.stats;
  const notCopied = s.skipped + s.errors;
  const lines = [
    "📊 <b>Итог по копированию сделок</b>",
    `За период: ${formatDuration(s.since)} (с ${s.since.slice(0, 16).replace("T", " ")} UTC)`,
    "",
    `Всего сделок трейдеров обнаружено: <b>${s.totalSeen}</b>`,
    `✅ Скопировано ботом: <b>${s.copied}</b>`,
    config.dryRun ? `🧪 В тестовом режиме, не отправлено: <b>${s.dryrun}</b>` : undefined,
    `⏭❌ Не скопировано всего: <b>${notCopied}</b>`,
    `   ⏭ пропущено по правилам: ${s.skipped}`,
    `   ❌ ошибка при отправке ордера: ${s.errors}`,
    "",
    "<b>Причины, почему пропущено:</b>",
    reasonLines(s.skipReasons),
    "",
    "<b>Причины ошибок при отправке:</b>",
    reasonLines(s.errorReasons),
    "",
    `Копируемые трейдеры: ${config.copyTraders.length}`,
    "",
    "Команда /reset_stats обнулит эту статистику.",
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
};

export interface TelegramCommandListenerOptions {
  botToken: string;
  /** Only messages from this chat are answered — everyone else is ignored. */
  chatId: string;
  state: State;
  config: Config;
  notifier: TelegramNotifier;
  logger: Logger;
  /** Called after each poll that consumed updates, so the offset gets persisted. */
  onStateChanged: () => Promise<void>;
}

/**
 * Long-polls the Telegram Bot API for incoming messages (getUpdates) and
 * replies with a trading stats summary. Any text message from the
 * configured chat triggers a reply; /reset_stats clears the counters.
 * Never throws out of `start()` — polling errors are logged and retried.
 */
export class TelegramCommandListener {
  private apiBase: string;
  private stopped = false;

  constructor(private opts: TelegramCommandListenerOptions) {
    this.apiBase = `https://api.telegram.org/bot${opts.botToken}`;
  }

  async start(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.opts.logger.warn("Telegram command polling error", {
          error: (err as Error).message,
        });
        await sleep(5000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async pollOnce(): Promise<void> {
    const { state } = this.opts;
    // timeout=25 uses Telegram's own long-polling, so this doesn't spam
    // requests while waiting for a message.
    const url = `${this.apiBase}/getUpdates?timeout=25&offset=${state.telegramUpdateOffset}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      this.opts.logger.warn("Telegram getUpdates failed", { status: resp.status });
      await sleep(5000);
      return;
    }
    const data = (await resp.json()) as { ok: boolean; result?: TelegramUpdate[] };
    if (!data.ok || !Array.isArray(data.result)) return;

    let consumed = false;
    for (const update of data.result) {
      state.telegramUpdateOffset = update.update_id + 1;
      consumed = true;

      const message = update.message;
      if (!message || !message.text) continue;

      // Only react to messages from the configured chat — prevents anyone
      // who finds/guesses the bot on Telegram from pulling your trading
      // stats if the token ever leaks.
      if (String(message.chat.id) !== this.opts.chatId) continue;

      const text = message.text.trim();
      try {
        if (text === "/reset_stats") {
          resetStats(state);
          await this.opts.notifier.send("🔄 Статистика сброшена, отсчёт начат заново.");
        } else {
          // Any other message (command or plain text) -> reply with the summary.
          await this.opts.notifier.send(formatStatsMessage(state, this.opts.config));
        }
      } catch (err) {
        this.opts.logger.warn("Failed to handle Telegram command", {
          error: (err as Error).message,
        });
      }
    }

    if (consumed) {
      await this.opts.onStateChanged();
    }
  }
}
