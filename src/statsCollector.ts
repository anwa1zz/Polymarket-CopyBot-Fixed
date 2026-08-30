/**
 * Сборщик статистики — НЕ торгует, только наблюдает и записывает исходы.
 * Для каждого NO-токена каждого градуса: фиксирует момент первого пересечения
 * порогов 0.95/0.96/0.97/0.98/0.99, сколько времени оставалось до конца рынка
 * в этот момент, и итоговый исход (успех = дошёл до ~1.00, разворот = упал до ~0.00).
 */

import "dotenv/config";
import { discoverWeatherMarkets, WeatherMarket } from "./marketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { createLogger } from "./logger.js";
import { createTelegramNotifier, TelegramNotifier } from "./telegram.js";

const THRESHOLDS = [0.95, 0.96, 0.97, 0.98, 0.99];
const SUCCESS_PRICE = 0.995; // считаем "дошёл до 1.00" при достижении этого уровня
const REVERSAL_PRICE = 0.02; // считаем "упал до 0.00" при падении ниже этого уровня
const SUMMARY_INTERVAL_MS = 3 * 60 * 60 * 1000; // сводка раз в 3 часа

type Outcome = "success" | "reversal" | "pending";

interface CrossingEvent {
  city: string;
  binLabel: string;
  threshold: number;
  crossedAt: number;
  timeRemainingMs: number; // сколько было до конца рынка в момент пересечения
  outcome: Outcome;
  resolvedAt: number | null;
}

interface TokenInfo {
  city: string;
  binLabel: string;
  marketEndMs: number;
}

function timeBucket(ms: number): string {
  const sec = ms / 1000;
  if (sec <= 30) return "0-30с";
  if (sec <= 120) return "30с-2мин";
  if (sec <= 300) return "2-5мин";
  if (sec <= 900) return "5-15мин";
  if (sec <= 3600) return "15-60мин";
  if (sec <= 14400) return "1-4ч";
  return ">4ч";
}

class StatsCollector {
  // по каждому токену — какие пороги уже зафиксированы (чтобы не дублировать событие)
  private crossedThresholds = new Map<string, Set<number>>();
  // все события, которые ещё ждут исхода
  private pendingEvents: CrossingEvent[] = [];
  // все завершённые события
  private finishedEvents: CrossingEvent[] = [];

  onPriceUpdate(tokenId: string, price: number, info: TokenInfo): void {
    const now = Date.now();

    // проверяем пороги на пересечение снизу вверх
    const already = this.crossedThresholds.get(tokenId) ?? new Set<number>();
    for (const th of THRESHOLDS) {
      if (price >= th && !already.has(th)) {
        already.add(th);
        const event: CrossingEvent = {
          city: info.city,
          binLabel: info.binLabel,
          threshold: th,
          crossedAt: now,
          timeRemainingMs: Math.max(0, info.marketEndMs - now),
          outcome: "pending",
          resolvedAt: null,
        };
        this.pendingEvents.push(event);
        console.log(`📌 Пересечение ${th}: ${info.city} / ${info.binLabel} (осталось ${timeBucket(event.timeRemainingMs)})`);
      }
    }
    this.crossedThresholds.set(tokenId, already);

    // проверяем исход для всех pending событий этого же токена
    const stillPending: CrossingEvent[] = [];
    for (const ev of this.pendingEvents) {
      if (ev.city !== info.city || ev.binLabel !== info.binLabel) {
        stillPending.push(ev);
        continue;
      }
      if (price >= SUCCESS_PRICE) {
        ev.outcome = "success";
        ev.resolvedAt = now;
        this.finishedEvents.push(ev);
        console.log(`✅ УСПЕХ: ${info.city} / ${info.binLabel} @ порог ${ev.threshold}`);
      } else if (price <= REVERSAL_PRICE) {
        ev.outcome = "reversal";
        ev.resolvedAt = now;
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

    // группируем по (порог, бакет времени)
    const groups = new Map<string, { success: number; reversal: number; pending: number }>();
    for (const ev of all) {
      const key = `${ev.threshold} | ${timeBucket(ev.timeRemainingMs)}`;
      const g = groups.get(key) ?? { success: 0, reversal: 0, pending: 0 };
      g[ev.outcome === "pending" ? "pending" : ev.outcome]++;
      groups.set(key, g);
    }

    const lines = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, g]) => {
        const total = g.success + g.reversal + g.pending;
        const rate = g.success + g.reversal > 0
          ? `${((g.success / (g.success + g.reversal)) * 100).toFixed(0)}%`
          : "н/д";
        return `${key}: успех=${g.success} разворот=${g.reversal} ждём=${g.pending} (винрейт=${rate})`;
      });

    return `📊 <b>Сводка статистики</b>\nВсего событий: ${all.length}\n\n${lines.join("\n")}`;
  }
}

async function main() {
  console.log("=== РЕЖИМ СБОРА СТАТИСТИКИ (без торговли, без алертов по сделкам) ===");

  const logger = createLogger(false);
  const telegram = createTelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, logger);
  if (telegram) {
    await telegram.send("📊 Бот переключён в режим сбора статистики. Торговля отключена. Сводки — раз в 3 часа.");
  }

  console.log("Загружаем список рынков (только highest, только сегодня)...");
  const markets: WeatherMarket[] = await discoverWeatherMarkets();

  const tokenIndex = new Map<string, TokenInfo>();
  const allTokenIds: string[] = [];

  for (const m of markets) {
    // endDate рынка нам нужен для "времени до конца" — берём из Gamma напрямую через доп.запрос,
    // т.к. в WeatherMarket сейчас это поле не сохраняется (targetDate — это дата, не точное время конца)
    let marketEndMs = Date.now() + 24 * 60 * 60 * 1000; // fallback, если не найдём точнее
    try {
      const resp = await fetch(`https://gamma-api.polymarket.com/events?slug=${m.eventSlug}`);
      const data = (await resp.json()) as any[];
      const endDate = data?.[0]?.markets?.[0]?.endDate;
      if (endDate) marketEndMs = new Date(endDate).getTime();
    } catch {
      // оставляем fallback
    }

    for (const b of m.bins) {
      tokenIndex.set(b.noTokenId, { city: m.city, binLabel: b.label, marketEndMs });
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
