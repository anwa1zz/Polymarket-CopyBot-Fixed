/**
 * Справочные данные погоды — берём ТОЧНО ТУ ЖЕ станцию, что использует
 * резолвер Polymarket (вытаскиваем код станции прямо из resolutionSource).
 * ТОЛЬКО для контекста в логах/телеграме — ни на что в решениях бота не влияет.
 *
 * Поддержаны два формата, которые реально встречаются на Polymarket:
 *   https://www.weather.gov/wrh/timeseries?site=XXXX       (большинство городов)
 *   https://www.wunderground.com/history/daily/cc/city/CODE (некоторые китайские города)
 * Если формат другой или resolutionSource пустой — просто возвращаем null,
 * без ошибок и без выдумывания данных.
 */

interface ParsedSource {
  kind: "nws" | "wunderground";
  code: string;
}

function parseResolutionSource(url: string): ParsedSource | null {
  if (!url) return null;

  const nwsMatch = url.match(/weather\.gov\/wrh\/timeseries\?site=([a-zA-Z0-9]+)/i);
  if (nwsMatch) return { kind: "nws", code: nwsMatch[1].toUpperCase() };

  const wuMatch = url.match(/wunderground\.com\/history\/daily\/[a-z]{2}\/[^/]+\/([A-Za-z0-9]+)/i);
  if (wuMatch) return { kind: "wunderground", code: wuMatch[1] };

  return null;
}

const cache = new Map<string, { value: string | null; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchNwsObservation(stationCode: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://api.weather.gov/stations/${stationCode}/observations/latest`, {
      headers: { "User-Agent": "polybot/0.1 (research)" },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const tempC = data?.properties?.temperature?.value;
    const time = data?.properties?.timestamp;
    if (tempC === null || tempC === undefined) return null;
    const tempF = (tempC * 9) / 5 + 32;
    return `NWS ${stationCode}: ${tempC.toFixed(1)}°C / ${tempF.toFixed(1)}°F (замер: ${time ?? "?"})`;
  } catch {
    return null;
  }
}

/**
 * city + resolutionSource берутся напрямую из WeatherMarket (marketDiscovery.ts).
 * Возвращает готовую строку для лога/телеграма или null, если источник не поддержан
 * (например, wunderground — у него нет удобного публичного API без ключа, поэтому
 * пока честно пропускаем такие города, а не гадаем).
 */
export async function fetchWeatherContext(city: string, resolutionSource: string): Promise<string | null> {
  const cacheKey = `${city}:${resolutionSource}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;

  const parsed = parseResolutionSource(resolutionSource);
  if (!parsed) return null;

  let value: string | null = null;
  if (parsed.kind === "nws") {
    value = await fetchNwsObservation(parsed.code);
  } else {
    // wunderground — пока не поддержано, честно не выдумываем данные
    value = null;
  }

  cache.set(cacheKey, { value, ts: Date.now() });
  return value;
}
