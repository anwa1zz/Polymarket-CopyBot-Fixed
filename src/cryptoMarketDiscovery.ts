/**
 * Модуль 1: поиск ВСЕХ активных крипто "Up or Down" рынков на Polymarket.
 * Поддерживает разные таймфреймы: 5-мин, 15-мин, час, 4 часа, день.
 * Список монет: BTC, ETH, SOL, XRP, DOGE.
 *
 * Логика: запрашиваем Gamma API по series_slug для каждой пары
 * монета+таймфрейм. Время закрытия окна берём из поля endDate самого
 * события (проверено — совпадает с реальностью до секунды), а не
 * парсим заголовок — заголовки у 4h/1d могут отличаться по формату,
 * а endDate универсален для всех таймфреймов.
 */

const GAMMA_HOST = "https://gamma-api.polymarket.com";

export interface CryptoUpDownMarket {
  coin: string;              // "Bitcoin", "Ethereum", "XRP", ...
  eventSlug: string;
  title: string;
  windowMinutes: number;     // 5, 15, 60, 240, 1440
  closeTimeMs: number;       // когда закрывается окно (unix ms, из endDate)
  upTokenId: string;
  downTokenId: string;
}

export interface TimeframeSpec {
  suffixes: string[]; // варианты названия серии, пробуем по очереди/все
  minutes: number;
}

// Торговый бот использует только это (5 мин + час) — таймфреймы,
// которые изначально просили для торговли.
export const TRADING_TIMEFRAMES: TimeframeSpec[] = [
  { suffixes: ["up-or-down-5m"], minutes: 5 },
  { suffixes: ["up-or-down-1h", "up-or-down-hourly", "updown-hourly"], minutes: 60 },
];

// Исследовательский логгер смотрит на всё сразу.
export const ALL_TIMEFRAMES: TimeframeSpec[] = [
  { suffixes: ["up-or-down-5m"], minutes: 5 },
  { suffixes: ["up-or-down-15m"], minutes: 15 },
  { suffixes: ["up-or-down-1h", "up-or-down-hourly", "updown-hourly"], minutes: 60 },
  { suffixes: ["up-or-down-4h", "up-or-down-4hour", "up-or-down-4hours", "updown-4h"], minutes: 240 },
  { suffixes: ["up-or-down-1d", "up-or-down-daily", "updown-1d", "updown-daily"], minutes: 1440 },
];

const COIN_TICKERS: Record<string, string> = {
  btc: "Bitcoin",
  eth: "Ethereum",
  sol: "Solana",
  xrp: "XRP",
  doge: "Dogecoin",
};

async function fetchEventsBySeriesSlug(seriesSlug: string): Promise<any[]> {
  const url = `${GAMMA_HOST}/events?series_slug=${seriesSlug}&closed=false&limit=500&order=endDate&ascending=true`;
  const resp = await fetch(url);
  if (!resp.ok) return [];
  return (await resp.json()) as any[];
}

function extractOutcomeTokens(market: any): { upTokenId: string; downTokenId: string } | null {
  let outcomes: string[];
  let tokenIds: string[];
  try {
    outcomes = JSON.parse(market.outcomes ?? "[]");
    tokenIds = JSON.parse(market.clobTokenIds ?? "[]");
  } catch {
    return null;
  }
  if (outcomes.length !== 2 || tokenIds.length !== 2) return null;

  const upIdx = outcomes.findIndex((o) => /^up$/i.test(o.trim()));
  const downIdx = outcomes.findIndex((o) => /^down$/i.test(o.trim()));
  if (upIdx === -1 || downIdx === -1) return null;

  return { upTokenId: tokenIds[upIdx], downTokenId: tokenIds[downIdx] };
}

export async function discoverCryptoUpDownMarkets(
  timeframes: TimeframeSpec[] = TRADING_TIMEFRAMES,
): Promise<CryptoUpDownMarket[]> {
  const now = Date.now();
  const MIN_CLOSE_MS = now - 2 * 60 * 1000;
  // Дальний горизонт зависит от таймфрейма — дневному рынку нужен запас
  // побольше, чтобы не отсечь его раньше времени.
  const results: CryptoUpDownMarket[] = [];

  for (const ticker of Object.keys(COIN_TICKERS)) {
    for (const tf of timeframes) {
      let events: any[] = [];
      for (const suffix of tf.suffixes) {
        const seriesSlug = `${ticker}-${suffix}`;
        const batch = await fetchEventsBySeriesSlug(seriesSlug);
        if (batch.length > 0) {
          events = batch;
          break; // нашли рабочий вариант названия — остальные не пробуем
        }
      }

      const maxCloseMs = now + tf.minutes * 60 * 1000 * 2 + 6 * 3600 * 1000;

      for (const ev of events) {
        const title: string = ev.title ?? "";
        const closeTimeMs = ev.endDate ? new Date(ev.endDate).getTime() : null;
        if (closeTimeMs === null) continue;
        if (closeTimeMs < MIN_CLOSE_MS || closeTimeMs > maxCloseMs) continue;

        const coinMatch = title.match(/^(\w+) Up or Down/);
        if (!coinMatch) continue;
        const coin = coinMatch[1];

        const market = (ev.markets ?? [])[0];
        if (!market) continue;
        const tokens = extractOutcomeTokens(market);
        if (!tokens) continue;

        results.push({
          coin,
          eventSlug: ev.slug,
          title,
          windowMinutes: tf.minutes,
          closeTimeMs,
          upTokenId: tokens.upTokenId,
          downTokenId: tokens.downTokenId,
        });
      }
    }
  }

  results.sort((a, b) => a.closeTimeMs - b.closeTimeMs);
  return results;
}

// Тестовый запуск: npx tsx src/cryptoMarketDiscovery.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  discoverCryptoUpDownMarkets(ALL_TIMEFRAMES).then((markets) => {
    console.log(`Найдено крипто up/down рынков (все таймфреймы): ${markets.length}`);

    const byWindow = new Map<number, number>();
    for (const m of markets) {
      byWindow.set(m.windowMinutes, (byWindow.get(m.windowMinutes) ?? 0) + 1);
    }
    console.log("По длительности окна (минут -> кол-во):", Object.fromEntries(byWindow));

    const coins = new Set(markets.map((m) => m.coin));
    console.log("Монеты:", [...coins].join(", "));

    console.log("\nБлижайшие к закрытию по каждому таймфрейму:");
    for (const minutes of [5, 15, 60, 240, 1440]) {
      const forTf = markets.filter((m) => m.windowMinutes === minutes);
      if (forTf.length === 0) {
        console.log(`  [${minutes} мин] НЕ НАЙДЕНО НИ ОДНОГО РЫНКА — проверить названия серий`);
        continue;
      }
      const m = forTf[0];
      const closeIn = Math.round((m.closeTimeMs - Date.now()) / 1000);
      console.log(`  [${minutes} мин] "${m.title}" — закрытие через ${closeIn}с`);
    }
  }).catch((err) => {
    console.error("Ошибка:", err);
    process.exit(1);
  });
}