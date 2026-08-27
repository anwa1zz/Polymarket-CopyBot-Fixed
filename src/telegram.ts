import { Logger } from "./logger.js";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/**
 * Very small wrapper around the Telegram Bot API. Sends plain notification
 * messages and never throws — a failed Telegram send should never crash the
 * trading loop, so all errors are swallowed and logged instead.
 */
export class TelegramNotifier {
  private apiUrl: string;

  constructor(private config: TelegramConfig, private logger: Logger) {
    this.apiUrl = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  }

  async send(text: string): Promise<void> {
    try {
      const resp = await fetch(this.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        this.logger.warn("Telegram notification failed", {
          status: resp.status,
          body,
        });
      }
    } catch (err) {
      this.logger.warn("Telegram notification error", {
        error: (err as Error).message,
      });
    }
  }
}

/**
 * Builds a TelegramNotifier from config, or returns undefined if Telegram
 * notifications are not configured. Callers should treat an undefined
 * notifier as "notifications disabled" and skip calling it.
 */
export const createTelegramNotifier = (
  botToken: string | undefined,
  chatId: string | undefined,
  logger: Logger,
): TelegramNotifier | undefined => {
  if (!botToken || !chatId) return undefined;
  return new TelegramNotifier({ botToken, chatId }, logger);
};
