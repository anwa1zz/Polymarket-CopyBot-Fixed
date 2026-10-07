/**
 * Исследовательский модуль (не торгует, только собирает статистику).
 *
 * Отслеживает ТОЛЬКО BTC 5-минутные Up/Down рынки на Polymarket.
 *
 * Одновременно симулирует НЕСКОЛЬКО стратегий на одних и тех же живых
 * данных (см. STRATEGIES ниже) — теперь включая более ранние точки входа
 * (0.90, 0.92, 0.95), не только 0.97/0.98.
 *
 * Логика "сделки" для стратегии с winEarlyLevel:
 *   1. Как только цена токена впервые касается entryLevel — фиксируем
 *      точку входа.
 *   2. С этого момента следим за минимальной ценой этого же токена —
 *      это максимальная просадка сделки.
 *   3. WIN фиксируется досрочно, если цена долетает до winEarlyLevel
 *      ДО официального резолва (если winEarlyLevel = null — ждём только
 *      резолва).
 *   4. Иначе итог определяется официальным резолвом через Gamma API.
 *
 * ДОПОЛНИТЕЛЬНО собираем:
 *   - spreadAtEntry     — спред (ask−bid) в момент входа.
 *   - bestSizeAtEntry   — размер лучшего уровня.
 *                         В текущей версии PriceWatcher размер не передаёт,
 *                         поэтому значение будет null.
 *   - entryHourUtc      — час UTC в момент входа.
 *   - msToMinPrice      — сколько мс прошло от входа до момента
 *                         наихудшей цены.
 *   - msToHalfCrash     — сколько мс прошло от входа до первого момента,
 *                         когда цена упала минимум вдвое от уровня входа.
 *   - bounceCount       — сколько раз после входа цена уходила ниже
 *                         entryLevel и затем возвращалась обратно ≥ entryLevel.
 *
 * Раз в REPORT_INTERVAL_MS шлёт промежуточную сводку в Telegram (если
 * настроен), и финальную — при остановке (Ctrl+C).
 *
 * Работает НЕЗАВИСИМО от sniperTrader.ts / fastFlip.ts — запускается
 * отдельным процессом, ничего не покупает, только смотрит.
 */

import "dotenv/config";
import {
  discoverCryptoUpDownMarkets,
  CryptoUpDownMarket,
} from "./cryptoMarketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { createTelegramNotifier } from "./telegram.js";
import { createLogger } from "./logger.js";

const TARGET_COIN = "Bitcoin";
const TARGET_WINDOW_MINUTES = 5;

const TIMEFRAMES_TO_DISCOVER = [
  {
    suffixes: ["up-or-down-5m"],
    minutes: TARGET_WINDOW_MINUTES,
  },
];

interface StrategySpec {
  name: string;
  entryLevel: number;
  winEarlyLevel: number | null;
}

const STRATEGIES: StrategySpec[] = [
  { name: "0.98→резолв", entryLevel: 0.98, winEarlyLevel: null },
  { name: "0.97→0.99", entryLevel: 0.97, winEarlyLevel: 0.99 },
  { name: "0.98→0.99", entryLevel: 0.98, winEarlyLevel: 0.99 },
  { name: "0.90→0.97", entryLevel: 0.9, winEarlyLevel: 0.97 },
  { name: "0.92→0.97", entryLevel: 0.92, winEarlyLevel: 0.97 },
  { name: "0.95→0.98", entryLevel: 0.95, winEarlyLevel: 0.98 },
];

const TIME_BUCKETS = [10, 30, 60, 120, 300];

const MARKET_REFRESH_MS = 30 * 1000;

function observeWindowMs(windowMinutes: number): number {
  return (windowMinutes + 1) * 60 * 1000;
}

const RESOLVE_CHECK_DELAY_SEC = 180;

const REPORT_TRIGGER_PHRASES = [
  "крипта итог",
  "crypto report",
  "/report",
];

const GAMMA_HOST = "https://gamma-api.polymarket.com";

interface TradeEvent {
  strategy: string;
  entryLevel: number;
  eventSlug: string;
  side: "Up" | "Down";
  entryTimestamp: number;
  secToCloseAtEntry: number;
  minPriceSinceEntry: number;
  determined: boolean;
  won: boolean | null;
  wonEarly: boolean;

  // Новые поля
  spreadAtEntry: number | null;
  bestSizeAtEntry: number | null;
  entryHourUtc: number;
  msToMinPrice: number;
  msToHalfCrash: number | null;
  bounceCount: number;

  // Служебные
  _crashHalfRecorded: boolean;
  _lastPriceBelowLevel: boolean;
}

interface TokenInfo {
  market: CryptoUpDownMarket;
  side: "Up" | "Down";
}

function buildTokenIndex(
  markets: CryptoUpDownMarket[],
): Map<string, TokenInfo> {
  const idx = new Map<string, TokenInfo>();

  for (const m of markets) {
    idx.set(m.upTokenId, {
      market: m,
      side: "Up",
    });

    idx.set(m.downTokenId, {
      market: m,
      side: "Down",
    });
  }

  return idx;
}

function timeBucketLabel(secToClose: number): string {
  for (let i = 0; i < TIME_BUCKETS.length; i++) {
    if (secToClose <= TIME_BUCKETS[i]) {
      const lo = i === 0 ? 0 : TIME_BUCKETS[i - 1];
      return `${lo}-${TIME_BUCKETS[i]}с`;
    }
  }

  return `>${TIME_BUCKETS[TIME_BUCKETS.length - 1]}с`;
}

function drawdownOf(t: TradeEvent): number {
  return Math.max(0, t.entryLevel - t.minPriceSinceEntry);
}

function drawdownBucket(dd: number): string {
  if (dd <= 0) return "0 (без просадки)";
  if (dd <= 0.02) return "0-0.02";
  if (dd <= 0.05) return "0.02-0.05";
  if (dd <= 0.1) return "0.05-0.10";
  if (dd <= 0.2) return "0.10-0.20";

  return ">0.20";
}

const DRAWDOWN_BUCKET_ORDER = [
  "0 (без просадки)",
  "0-0.02",
  "0.02-0.05",
  "0.05-0.10",
  "0.10-0.20",
  ">0.20",
];

function hourBucketLabel(hourUtc: number): string {
  if (hourUtc < 6) return "0-6 UTC";
  if (hourUtc < 12) return "6-12 UTC";
  if (hourUtc < 18) return "12-18 UTC";

  return "18-24 UTC";
}

class ResearchLogger {
  private watcher: PriceWatcher | null = null;

  private tokenIndex = new Map<string, TokenInfo>();

  private lastTokenIds: string[] = [];

  private trades = new Map<string, TradeEvent>();

  private tradesList: TradeEvent[] = [];

  private pendingResolution = new Map<
    string,
    {
      closeTimeMs: number;
    }
  >();

  private updateCount = 0;

  async refreshMarkets(): Promise<void> {
    let allMarkets: CryptoUpDownMarket[];

    try {
      allMarkets = await discoverCryptoUpDownMarkets(
        TIMEFRAMES_TO_DISCOVER,
      );
    } catch (err) {
      console.error(
        "[refresh] ошибка:",
        (err as Error).message,
      );

      return;
    }

    const now = Date.now();

    const markets = allMarkets.filter(
      (m) =>
        m.coin.toUpperCase() === TARGET_COIN.toUpperCase() &&
        m.windowMinutes === TARGET_WINDOW_MINUTES &&
        m.closeTimeMs - now <= observeWindowMs(m.windowMinutes),
    );

    this.tokenIndex = buildTokenIndex(markets);

    const tokenIds = [...this.tokenIndex.keys()].sort();

    for (const m of markets) {
      if (!this.pendingResolution.has(m.eventSlug)) {
        this.pendingResolution.set(m.eventSlug, {
          closeTimeMs: m.closeTimeMs,
        });
      }
    }

    console.log(
      `[refresh] наблюдаем BTC 5-мин рынков: ${markets.length} ` +
        `(${tokenIds.length} токенов), ` +
        `сделок открыто: ${this.tradesList.length}, ` +
        `ждём резолва: ${this.pendingResolution.size}`,
    );

    const sameAsLastTime =
      tokenIds.length === this.lastTokenIds.length &&
      tokenIds.every(
        (id, i) => id === this.lastTokenIds[i],
      );

    if (sameAsLastTime && this.watcher) {
      return;
    }

    this.lastTokenIds = tokenIds;

    this.watcher?.stop();

    if (tokenIds.length === 0) {
      this.watcher = null;
      return;
    }

    this.watcher = new PriceWatcher(
      tokenIds,
      (u) => this.onPriceUpdate(u),
    );

    this.watcher.start();
  }

  private onPriceUpdate(update: PriceUpdate): void {
    this.updateCount++;

    const info = this.tokenIndex.get(update.tokenId);

    if (!info) return;

    const { market, side } = info;

    const prices = [
      update.bestBid,
      update.bestAsk,
    ].filter(
      (p): p is number => p !== null,
    );

    if (prices.length === 0) return;

    const price = Math.max(...prices);

    const spread =
      update.bestAsk !== null &&
      update.bestBid !== null
        ? update.bestAsk - update.bestBid
        : null;

    // PriceWatcher сейчас НЕ передаёт bestBidSize/bestAskSize.
    // Поэтому объём при входе пока не собираем.
    const bestSize: number | null = null;

    const now = Date.now();

    for (const spec of STRATEGIES) {
      const key =
        `${spec.name}:${market.eventSlug}:${side}`;

      const existing = this.trades.get(key);

      if (existing) {
        if (existing.determined) continue;

        // Обновляем максимальную просадку
        if (price < existing.minPriceSinceEntry) {
          existing.minPriceSinceEntry = price;
          existing.msToMinPrice =
            now - existing.entryTimestamp;
        }

        // Проверяем падение минимум вдвое
        if (
          !existing._crashHalfRecorded &&
          price <= existing.entryLevel / 2
        ) {
          existing.msToHalfCrash =
            now - existing.entryTimestamp;

          existing._crashHalfRecorded = true;
        }

        // Считаем отскоки
        if (price < existing.entryLevel) {
          existing._lastPriceBelowLevel = true;
        } else if (
          existing._lastPriceBelowLevel
        ) {
          existing.bounceCount++;
          existing._lastPriceBelowLevel = false;
        }

        // Досрочная победа
        if (
          spec.winEarlyLevel !== null &&
          price >= spec.winEarlyLevel
        ) {
          existing.determined = true;
          existing.won = true;
          existing.wonEarly = true;
        }

        continue;
      }

      // Цена ещё не достигла уровня входа
      if (price < spec.entryLevel) continue;

      const secToClose =
        (market.closeTimeMs - now) / 1000;

      const trade: TradeEvent = {
        strategy: spec.name,
        entryLevel: spec.entryLevel,
        eventSlug: market.eventSlug,
        side,

        entryTimestamp: now,

        secToCloseAtEntry: secToClose,

        minPriceSinceEntry: price,

        determined: false,

        won: null,

        wonEarly: false,

        spreadAtEntry: spread,

        bestSizeAtEntry: bestSize,

        entryHourUtc: new Date(now).getUTCHours(),

        msToMinPrice: 0,

        msToHalfCrash: null,

        bounceCount: 0,

        _crashHalfRecorded: false,

        _lastPriceBelowLevel: false,
      };

      this.trades.set(key, trade);

      this.tradesList.push(trade);
    }
  }

  async checkResolutions(): Promise<void> {
    const now = Date.now();

    const toCheck: string[] = [];

    for (const [
      slug,
      info,
    ] of this.pendingResolution) {
      if (
        now - info.closeTimeMs >=
        RESOLVE_CHECK_DELAY_SEC * 1000
      ) {
        toCheck.push(slug);
      }
    }

    for (const slug of toCheck) {
      try {
        const resp = await fetch(
          `${GAMMA_HOST}/events/slug/${slug}`,
        );

        if (!resp.ok) continue;

        const event = await resp.json();

        const market =
          (event.markets ?? [])[0];

        if (!market) continue;

        let outcomes: string[];
        let outcomePrices: string[];

        try {
          outcomes = JSON.parse(
            market.outcomes ?? "[]",
          );

          outcomePrices = JSON.parse(
            market.outcomePrices ?? "[]",
          );
        } catch {
          continue;
        }

        if (
          outcomes.length !== 2 ||
          outcomePrices.length !== 2
        ) {
          continue;
        }

        const upIdx = outcomes.findIndex(
          (o) => /^up$/i.test(o.trim()),
        );

        const downIdx = outcomes.findIndex(
          (o) => /^down$/i.test(o.trim()),
        );

        if (
          upIdx === -1 ||
          downIdx === -1
        ) {
          continue;
        }

        const upPrice = Number(
          outcomePrices[upIdx],
        );

        const downPrice = Number(
          outcomePrices[downIdx],
        );

        if (
          upPrice > 0.05 &&
          upPrice < 0.95
        ) {
          continue;
        }

        const winner: "Up" | "Down" =
          upPrice > downPrice
            ? "Up"
            : "Down";

        for (const spec of STRATEGIES) {
          for (const side of [
            "Up",
            "Down",
          ] as const) {
            const t = this.trades.get(
              `${spec.name}:${slug}:${side}`,
            );

            if (t && !t.determined) {
              t.determined = true;

              t.won =
                side === winner;

              t.wonEarly = false;
            }
          }
        }

        this.pendingResolution.delete(slug);
      } catch (err) {
        console.error(
          `[resolve] ошибка проверки ${slug}:`,
          (err as Error).message,
        );
      }
    }
  }

  private buildStrategyReport(
    spec: StrategySpec,
  ): string[] {
    const lines: string[] = [];

    const all = this.tradesList.filter(
      (t) => t.strategy === spec.name,
    );

    const determined = all.filter(
      (t) => t.determined,
    );

    const pending =
      all.length - determined.length;

    const wins = determined.filter(
      (t) => t.won,
    );

    const losses = determined.filter(
      (t) => !t.won,
    );

    lines.push(
      `<b>═══ ${spec.name} ═══</b>`,
    );

    lines.push(
      `Всего сделок: ${all.length} ` +
        `(резолвнуто: ${determined.length}, ` +
        `ждём: ${pending})`,
    );

    if (determined.length > 0) {
      const winRate =
        (wins.length / determined.length) *
        100;

      const earlyWins = wins.filter(
        (t) => t.wonEarly,
      ).length;

      const earlyNote =
        spec.winEarlyLevel !== null
          ? `, из них ранних по ${spec.winEarlyLevel}: ${earlyWins}`
          : "";

      lines.push(
        `Win rate: ${wins.length}/${determined.length} ` +
          `(${winRate.toFixed(1)}%)${earlyNote}`,
      );
    }

    lines.push("");

    const drawdownReport = (
      label: string,
      list: TradeEvent[],
    ) => {
      if (list.length === 0) return;

      const dds = list.map(drawdownOf);

      const avg =
        dds.reduce(
          (a, b) => a + b,
          0,
        ) / dds.length;

      const worst = Math.max(...dds);

      lines.push(
        `  <b>Просадка — ${label} (${list.length})</b>`,
      );

      lines.push(
        `    средняя: ${avg.toFixed(4)}, ` +
          `максимальная: ${worst.toFixed(4)}`,
      );

      const buckets =
        new Map<string, number>();

      for (const dd of dds) {
        const b = drawdownBucket(dd);

        buckets.set(
          b,
          (buckets.get(b) ?? 0) + 1,
        );
      }

      for (
        const b of DRAWDOWN_BUCKET_ORDER
      ) {
        const c = buckets.get(b);

        if (!c) continue;

        const pct =
          (c / list.length) * 100;

        lines.push(
          `      ${b}: ${c} (${pct.toFixed(0)}%)`,
        );
      }
    };

    drawdownReport(
      "выигрышные",
      wins,
    );

    drawdownReport(
      "проигрышные",
      losses,
    );

    lines.push("");

    // Скорость крушения
    const crashReport = (
      label: string,
      list: TradeEvent[],
    ) => {
      if (list.length === 0) return;

      const withCrash =
        list.filter(
          (t) =>
            t.msToHalfCrash !== null,
        );

      const pct =
        (withCrash.length /
          list.length) *
        100;

      lines.push(
        `  <b>Крах вдвое (${label}, ${list.length})</b>: ` +
          `было у ${withCrash.length} ` +
          `(${pct.toFixed(0)}%)`,
      );

      if (withCrash.length > 0) {
        const avgMs =
          withCrash.reduce(
            (s, t) =>
              s +
              (t.msToHalfCrash ?? 0),
            0,
          ) / withCrash.length;

        const minMs = Math.min(
          ...withCrash.map(
            (t) =>
              t.msToHalfCrash ?? 0,
          ),
        );

        lines.push(
          `    среднее время до краха: ` +
            `${(avgMs / 1000).toFixed(1)}с, ` +
            `самое быстрое: ` +
            `${(minMs / 1000).toFixed(1)}с`,
        );
      }
    };

    crashReport(
      "выигрышные",
      wins,
    );

    crashReport(
      "проигрышные",
      losses,
    );

    lines.push("");

    // Отскоки, спред, объём
    const microReport = (
      label: string,
      list: TradeEvent[],
    ) => {
      if (list.length === 0) return;

      const avgBounce =
        list.reduce(
          (s, t) =>
            s + t.bounceCount,
          0,
        ) / list.length;

      const spreads = list
        .map(
          (t) =>
            t.spreadAtEntry,
        )
        .filter(
          (s): s is number =>
            s !== null,
        );

      const avgSpread =
        spreads.length
          ? spreads.reduce(
              (a, b) => a + b,
              0,
            ) / spreads.length
          : null;

      const sizes = list
        .map(
          (t) =>
            t.bestSizeAtEntry,
        )
        .filter(
          (s): s is number =>
            s !== null,
        );

      const avgSize =
        sizes.length
          ? sizes.reduce(
              (a, b) => a + b,
              0,
            ) / sizes.length
          : null;

      lines.push(
        `  <b>Микроструктура — ${label}</b>: ` +
          `отскоков в среднем ${avgBounce.toFixed(2)}` +
          (
            avgSpread !== null
              ? `, спред при входе ${avgSpread.toFixed(4)}`
              : ""
          ) +
          (
            avgSize !== null
              ? `, объём при входе ${avgSize.toFixed(1)}`
              : ""
          ),
      );
    };

    microReport(
      "выигрышные",
      wins,
    );

    microReport(
      "проигрышные",
      losses,
    );

    lines.push("");

    if (determined.length > 0) {
      lines.push(
        `  <b>Win rate по времени до закрытия на входе</b>`,
      );

      const byBucket =
        new Map<
          string,
          {
            win: number;
            total: number;
          }
        >();

      for (const t of determined) {
        const b =
          timeBucketLabel(
            t.secToCloseAtEntry,
          );

        const s =
          byBucket.get(b) ??
          {
            win: 0,
            total: 0,
          };

        s.total++;

        if (t.won) {
          s.win++;
        }

        byBucket.set(b, s);
      }

      for (
        const [b, s] of [
          ...byBucket.entries(),
        ].sort()
      ) {
        const pct =
          (s.win / s.total) *
          100;

        lines.push(
          `    ${b} до закрытия: ` +
            `${s.win}/${s.total} ` +
            `(${pct.toFixed(0)}%)`,
        );
      }

      lines.push("");

      lines.push(
        `  <b>Win rate по часу UTC на входе</b>`,
      );

      const byHour =
        new Map<
          string,
          {
            win: number;
            total: number;
          }
        >();

      for (const t of determined) {
        const b =
          hourBucketLabel(
            t.entryHourUtc,
          );

        const s =
          byHour.get(b) ??
          {
            win: 0,
            total: 0,
          };

        s.total++;

        if (t.won) {
          s.win++;
        }

        byHour.set(b, s);
      }

      for (const b of [
        "0-6 UTC",
        "6-12 UTC",
        "12-18 UTC",
        "18-24 UTC",
      ]) {
        const s =
          byHour.get(b);

        if (!s) continue;

        const pct =
          (s.win / s.total) *
          100;

        lines.push(
          `    ${b}: ${s.win}/${s.total} ` +
            `(${pct.toFixed(0)}%)`,
        );
      }
    }

    lines.push("");

    return lines;
  }

  buildReport(): string {
    const lines: string[] = [];

    lines.push(
      `<b>📊 Отчёт BTC 5-мин — сравнение стратегий (v2, микроструктура)</b>`,
    );

    lines.push(
      `Всего сделок по всем стратегиям: ${this.tradesList.length}`,
    );

    lines.push("");

    for (const spec of STRATEGIES) {
      lines.push(
        ...this.buildStrategyReport(spec),
      );
    }

    return lines.join("\n");
  }

  start(): void {
    this.refreshMarkets();

    setInterval(
      () => this.refreshMarkets(),
      MARKET_REFRESH_MS,
    );

    setInterval(
      () => this.checkResolutions(),
      30 * 1000,
    );

    setInterval(
      () => {
        console.log(
          `--- статус: апдейтов цены ${this.updateCount}, ` +
            `сделок ${this.tradesList.length} ---`,
        );
      },
      60 * 1000,
    );
  }
}

async function pollTelegramCommands(
  botToken: string,
  chatId: string,
  telegram: ReturnType<
    typeof createTelegramNotifier
  >,
  research: ResearchLogger,
): Promise<void> {
  let offset = 0;

  const apiUrl =
    `https://api.telegram.org/bot${botToken}/getUpdates`;

  for (;;) {
    try {
      const resp = await fetch(
        `${apiUrl}?offset=${offset}&timeout=25`,
      );

      if (!resp.ok) {
        await new Promise(
          (r) => setTimeout(r, 5000),
        );

        continue;
      }

      const data =
        await resp.json();

      for (
        const update of data.result ?? []
      ) {
        offset =
          update.update_id + 1;

        const msg =
          update.message;

        if (
          !msg?.text ||
          String(msg.chat?.id) !==
            String(chatId)
        ) {
          continue;
        }

        const text =
          msg.text.toLowerCase();

        const matched =
          REPORT_TRIGGER_PHRASES.some(
            (p) =>
              text.includes(
                p.toLowerCase(),
              ),
          );

        if (matched) {
          console.log(
            `[telegram] Запрос отчёта получен: "${msg.text}"`,
          );

          await telegram?.send(
            research.buildReport(),
          );
        }
      }
    } catch (err) {
      console.error(
        "[telegram poll] ошибка:",
        (err as Error).message,
      );

      await new Promise(
        (r) => setTimeout(r, 5000),
      );
    }
  }
}

async function main() {
  console.log(
    "Исследовательский логгер запущен " +
      "(BTC 5-мин, 6 стратегий + микроструктура, " +
      "только сбор статистики).",
  );

  console.log(
    "Стратегии:",
    STRATEGIES
      .map((s) => s.name)
      .join(", "),
  );

  const logger =
    createLogger(false);

  const telegram =
    createTelegramNotifier(
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.TELEGRAM_CHAT_ID,
      logger,
    );

  const research =
    new ResearchLogger();

  research.start();

  if (
    telegram &&
    process.env.TELEGRAM_BOT_TOKEN &&
    process.env.TELEGRAM_CHAT_ID
  ) {
    console.log(
      `Telegram включён — напиши боту "${REPORT_TRIGGER_PHRASES[0]}" в любой момент, чтобы получить сводку.`,
    );

    pollTelegramCommands(
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.TELEGRAM_CHAT_ID,
      telegram,
      research,
    );
  } else {
    console.log(
      "Telegram не настроен — отчёт будет только в консоли.",
    );
  }

  const sendFinal = async () => {
    console.log(
      "\n" + research.buildReport(),
    );

    if (telegram) {
      await telegram.send(
        "🌙 Финальный отчёт за ночь:\n\n" +
          research.buildReport(),
      );
    }

    process.exit(0);
  };

  process.on(
    "SIGINT",
    sendFinal,
  );

  process.on(
    "SIGTERM",
    sendFinal,
  );
}

main().catch((err) => {
  console.error(
    "Фатальная ошибка:",
    err,
  );

  process.exit(1);
});