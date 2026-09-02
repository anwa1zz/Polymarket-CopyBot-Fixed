/**
 * Сборщик статистики — НЕ торгует, только наблюдает.
 * Для каждого порога (0.95-0.99) считает: сколько раз цена NO, дойдя до этого
 * порога, в итоге дошла до ~1.00 (успех) или упала до ~0.00 (разворот).
 * Плюс отдельная разбивка по городам — где разворотов больше/меньше.
 */

import "dotenv/config";
import { discoverWeatherMarkets, WeatherMarket } from "./marketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { createLogger } from "./logger.js";
import { createTelegramNotifier, TelegramNotifier } from "./telegram.js";

const THRESHOLDS = [0.95, 0.96, 0.97, 0.98, 0.99, 0.995];
const SUCCESS_PRICE = 0.995;
const REVERSAL_PRICE = 0.02;
const SUMMARY_INTERVAL_MS = 3 * 60 * 60 * 1000;

type Outcome = "success" | "reversal" | "pending";

interface CrossingEvent {
  city: string;
  binLabel: string;
  threshold: number;
  outcome: Outcome;
}

interface TokenInfo {
  city: string;
  binLabel: string;
}

class StatsCollector {
  private crossedThresholds = new Map<string, Set<number>>();
  private pendingEvents: CrossingEvent[] = [];
  private finishedEvents: CrossingEvent[] = [];

  onPriceUpdate(tokenId: string, price: number, info: TokenInfo): void {
    const already = this.crossedThresholds.get(tokenId) ?? new Set<number>();
    for (const th of THRESHOLDS) {
      if (price >= th && !already.has(th)) {
        already.add(th);
        const event: CrossingEvent = {
          city: info.city,
          binLabel: info.binLabel,
          threshold: th,
          outcome: "pending",
        };
        this.pendingEvents.push(event);
        console.log(`📌 Пересечение ${th}: ${info.city} / ${info.binLabel}`);
      }
    }
    this.crossedThresholds.set(tokenId, already);

    const stillPending: CrossingEvent[] = [];
    for (const ev of this.pendingEvents) {
      if (ev.city !== info.city || ev.binLabel !== info.binLabel) {
        stillPending.push(ev);
        continue;
      }
      if (price >= SUCCESS_PRICE) {
        ev.outcome = "success";
        this.finishedEvents.push(ev);
        console.log(`✅ УСПЕХ: ${info.city} / ${info.binLabel} @ порог ${ev.threshold}`);
      } else if (price <= REVERSAL_PRICE) {
        ev.outcome = "reversal";
        this.finishedEvents.push(ev);
        console.log(`💥 РАЗВОРОТ: ${info.city} / ${info.binLabel} @ порог ${ev.threshold}`);
      } else {
        stillPending.push(ev);
      }
    }
    this.pendingEvents = stillPending;
  }

  buildSummary(): string {
    const all = [...this.finishedEvents, ...this.pendingEvents];
    if (all.length === 0) return "📊 Сводка: событий пока не зафиксировано.";

    // --- разбивка по порогам (как раньше) ---
    const byThreshold = new Map<number, { success: number; reversal: number; pending: number }>();
    for (const th of THRESHOLDS) byThreshold.set(th, { success: 0, reversal: 0, pending: 0 });
    for (const ev of all) {
      const g = byThreshold.get(ev.threshold)!;
      g[ev.outcome]++;
    }
    const thresholdLines = THRESHOLDS.map((th) => {
      const g = byThreshold.get(th)!;
      const decided = g.success + g.reversal;
      const rate = decided > 0 ? `${((g.success / decided) * 100).toFixed(1)}%` : "н/д";
      return `${th}: успех=${g.success} разворот=${g.reversal} ждём=${g.pending} | винрейт=${rate}`;
    });

    // --- новая разбивка по городам (только порог 0.98, чтобы не путать несколько порогов в одной строке) ---
    const byCity = new Map<string, { success: number; reversal: number }>();
    for (const ev of all) {
      if (ev.threshold !== 0.98) continue; // фиксируем один порог для честного сравнения городов между собой
      if (ev.outcome === "pending") continue;
      const g = byCity.get(ev.city) ?? { success: 0, reversal: 0 };
      g[ev.outcome]++;
      byCity.set(ev.city, g);
    }
    const cityLines = [...byCity.entries()]
      .map(([city, g]) => {
        const total = g.success + g.reversal;
        const rate = total > 0 ? `${((g.success / total) * 100).toFixed(1)}%` : "н/д";
        return { city, total, line: `${city}: успех=${g.success} разворот=${g.reversal} | винрейт=${rate}` };
      })
      .sort((a, b) => b.total - a.total) // сначала города с наибольшим числом событий
      .map((x) => x.line);

    return (
      `📊 <b>Сводка статистики</b>\nВсего событий: ${all.length}\n\n` +
      `<b>По порогам:</b>\n${thresholdLines.join("\n")}\n\n` +
      `<b>По городам (порог 0.98):</b>\n${cityLines.join("\n") || "(нет данных)"}`
    );
  }
}

async function main() {
  console.log("=== РЕЖИМ СБОРА СТАТИСТИКИ (по порогам + по городам) ===");

  const logger = createLogger(false);
  const telegram = createTelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, logger);
  if (telegram) {
    await telegram.send("📊 Бот в режиме сбора статистики (пороги + города). Сводки — раз в 3 часа.");
  }

  console.log("Загружаем список рынков (только highest, только сегодня)...");
  const markets: WeatherMarket[] = await discoverWeatherMarkets();

  const tokenIndex = new Map<string, TokenInfo>();
  const allTokenIds: string[] = [];

  for (const m of markets) {
    for (const b of m.bins) {
      tokenIndex.set(b.noTokenId, { city: m.city, binLabel: b.label });
      allTokenIds.push(b.noTokenId);
    }
  }

  console.log(`Мониторим ${markets.length} рынков, ${allTokenIds.length} NO-токенов`);

  const collector = new StatsCollector();

  const watcher = new PriceWatcher(allTokenIds, (update: PriceUpdate) => {
    const price = update.bestAsk ?? update.bestBid;
    if (price === null) return;
    const info = tokenIndex.get(update.tokenId);
    if (!info) return;
    collector.onPriceUpdate(update.tokenId, price, info);
  });

  watcher.start();

  setInterval(async () => {
    const summary = collector.buildSummary();
    console.log(summary.replace(/<\/?b>/g, ""));
    await telegram?.send(summary);
  }, SUMMARY_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
  process.exit(1);
});
