/**
 * Модуль 1: поиск активных погодных рынков на Polymarket через Gamma API.
 * Только "highest temperature", только рынки на СЕГОДНЯ (по UTC-дате).
 */

export interface WeatherBin {
  label: string;
  lowValue: number;
  highValue: number;
  yesTokenId: string;
  noTokenId: string;
}

export interface WeatherMarket {
  city: string;
  eventSlug: string;
  metric: "high" | "low";
  targetDate: string;
  bins: WeatherBin[];
}

const GAMMA_HOST = "https://gamma-api.polymarket.com";

function parseBinFromTitle(title: string): { low: number; high: number } | null {
  const range = title.match(/(-?\d+)\s*-\s*(-?\d+)\s*°?\s*[CF]/i);
  if (range) return { low: Number(range[1]), high: Number(range[2]) };

  const orBelow = title.match(/(-?\d+)\s*°?\s*[CF]?\s*or below/i);
  if (orBelow) return { low: -1000, high: Number(orBelow[1]) };

  const orAbove = title.match(/(-?\d+)\s*°?\s*[CF]?\s*or (higher|above)/i);
  if (orAbove) return { low: Number(orAbove[1]), high: 1000 };

  const single = title.match(/be (?:exactly )?(-?\d+)\s*°?\s*[CF]?(?:\s+on\s|\?|$)/i);
  if (single) {
    const v = Number(single[1]);
    return { low: v, high: v };
  }
  return null;
}

export async function fetchActiveWeatherEvents(limit = 100): Promise<any[]> {
  const events: any[] = [];
  let offset = 0;
  for (;;) {
    const url = `${GAMMA_HOST}/events?tag_slug=weather&active=true&closed=false&limit=${limit}&offset=${offset}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Gamma API error: ${resp.status}`);
    const batch = (await resp.json()) as any[];
    events.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    if (offset > 2000) break;
  }
  return events;
}

export function parseWeatherEvent(event: any): WeatherMarket | null {
  const title: string = event.title ?? "";
  const isHigh = /highest temperature/i.test(title);
  // Только highest — lowest сознательно отключён по твоему решению
  if (!isHigh) return null;

  const cityMatch = title.match(/temperature in ([A-Za-z\s]+?) (be|on)/i) ||
                     title.match(/temperature in ([A-Za-z\s]+?)\?/i);
  const city = cityMatch ? cityMatch[1].trim() : null;
  if (!city) return null;

  const bins: WeatherBin[] = [];
  for (const m of event.markets ?? []) {
    const parsed = parseBinFromTitle(m.question ?? "");
    if (!parsed) continue;
    let tokenIds: string[];
    try {
      tokenIds = JSON.parse(m.clobTokenIds ?? "[]");
    } catch {
      continue;
    }
    if (tokenIds.length !== 2) continue;
    bins.push({
      label: m.groupItemTitle ?? m.question,
      lowValue: parsed.low,
      highValue: parsed.high,
      yesTokenId: tokenIds[0],
      noTokenId: tokenIds[1],
    });
  }
  if (bins.length === 0) return null;

  return {
    city,
    eventSlug: event.slug,
    metric: "high",
    targetDate: event.eventDate ?? "",
    bins,
  };
}

export async function discoverWeatherMarkets(): Promise<WeatherMarket[]> {
  const events = await fetchActiveWeatherEvents();
  const todayUtc = new Date().toISOString().slice(0, 10); // например "2026-08-29"

  const markets: WeatherMarket[] = [];
  for (const ev of events) {
    const parsed = parseWeatherEvent(ev);
    if (!parsed) continue;

    // Только сегодняшняя дата (по UTC — см. пояснение в чате про краевой случай
    // на границе суток для городов далеко на востоке)
    if (parsed.targetDate !== todayUtc) continue;

    markets.push(parsed);
  }
  return markets;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  discoverWeatherMarkets().then((markets) => {
    console.log(`Найдено рынков на сегодня (только highest): ${markets.length}`);
    console.log(`Всего бинов: ${markets.reduce((s, m) => s + m.bins.length, 0)}`);
    console.log("Города:", markets.map((m) => m.city).join(", "));
  }).catch((err) => {
    console.error("Ошибка:", err);
    process.exit(1);
  });
}
