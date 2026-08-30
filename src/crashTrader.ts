/**
 * Детектор обвала YES -> подтверждение живой цены NO -> покупка -> risk-лимиты -> Telegram.
 * + асинхронный сбор данных NWS-метеостанций (только для статистики, не блокирует сделку).
 */

import "dotenv/config";
import { Side } from "@polymarket/clob-client-v2";
import { discoverWeatherMarkets, WeatherMarket } from "./marketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { CrashDetector, CrashSignal } from "./crashDetector.js";
import { ClobService } from "./clob.js";
import { createLogger, Logger } from "./logger.js";
import { createTelegramNotifier, TelegramNotifier } from "./telegram.js";

const DRY_RUN = (process.env.CRASH_DRY_RUN ?? "true").toLowerCase() !== "false";
const TRADE_SIZE_USD = Number(process.env.CRASH_TRADE_SIZE_USD ?? "5");
const MAX_SLIPPAGE_PCT = Number(process.env.CRASH_MAX_SLIPPAGE_PCT ?? "1");
const MAX_MARKET_EXPOSURE_USD = Number(process.env.CRASH_MAX_MARKET_EXPOSURE_USD ?? "15");
const MAX_DAILY_TOTAL_USD = Number(process.env.CRASH_MAX_DAILY_TOTAL_USD ?? "100");

// Не покупаем NO, пока его живая цена не достигнет этого уровня
const MIN_NO_ENTRY_PRICE = Number(process.env.CRASH_MIN_NO_ENTRY_PRICE ?? "0.98");
// Сколько ждём (секунд), пока NO дорастёт до порога, прежде чем сдаться
const NO_CONFIRM_TIMEOUT_SEC = Number(process.env.CRASH_NO_CONFIRM_TIMEOUT_SEC ?? "15");
// Как часто проверяем цену NO в это окно ожидания
const NO_CONFIRM_POLL_MS = 1000;

interface TokenInfo {
  yesTokenId: string;
  noTokenId: string;
  city: string;
  binLabel: string;
  eventSlug: string;
}

// Известные NWS-станции по городам (частично — расширяем по мере надобности).
// Используется ТОЛЬКО для справочного лога, ни на что в решении о покупке не влияет.
const CITY_STATIONS: Record<string, string> = {
  "New York City": "KNYC",
  "Chicago": "KORD",
  "Miami": "KMIA",
  "Los Angeles": "KLAX",
  "Denver": "KDEN",
  "Dallas": "KDAL",
  "Houston": "KHOU",
  "Atlanta": "KATL",
  "Seattle": "KSEA",
  "San Francisco": "KSFO",
  "Austin": "KAUS",
};

async function fetchStationContext(city: string): Promise<string | null> {
  const station = CITY_STATIONS[city];
  if (!station) return null;
  try {
    const resp = await fetch(`https://api.weather.gov/stations/${station}/observations/latest`, {
      headers: { "User-Agent": "polybot/0.1 (research)" },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const tempC = data?.properties?.temperature?.value;
    if (tempC === null || tempC === undefined) return null;
    const tempF = (tempC * 9) / 5 + 32;
    return `NWS ${station}: ${tempC.toFixed(1)}°C / ${tempF.toFixed(1)}°F (справочно, не влияет на решение)`;
  } catch {
    return null;
  }
}

function buildTokenIndex(markets: WeatherMarket[]): Map<string, TokenInfo> {
  const index = new Map<string, TokenInfo>();
  for (const m of markets) {
    for (const b of m.bins) {
      index.set(b.yesTokenId, {
        yesTokenId: b.yesTokenId,
        noTokenId: b.noTokenId,
        city: m.city,
        binLabel: b.label,
        eventSlug: m.eventSlug,
      });
    }
  }
  return index;
}

// Живая цена NO через публичный REST-эндпоинт стакана — работает без авторизации,
// поэтому доступна и в DRY_RUN, и в LIVE одинаково.
async function getLiveBestAsk(tokenId: string): Promise<number | null> {
  try {
    const resp = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const asks = (data.asks ?? []).map((a: any) => Number(a.price)).filter((p: number) => Number.isFinite(p));
    return asks.length ? Math.min(...asks) : null;
  } catch {
    return null;
  }
}

/**
 * Ждём, пока живая цена NO реально достигнет MIN_NO_ENTRY_PRICE, прежде чем покупать.
 * Если NO уже там (как в примере с Панамой) — вернётся почти мгновенно.
 * Если NO медленно сползает (как Буэнос-Айрес) и не успевает за отведённое время — вернёт null (пропуск).
 */
async function waitForNoConfirmation(noTokenId: string): Promise<number | null> {
  const deadline = Date.now() + NO_CONFIRM_TIMEOUT_SEC * 1000;
  while (Date.now() < deadline) {
    const price = await getLiveBestAsk(noTokenId);
    if (price !== null && price >= MIN_NO_ENTRY_PRICE) {
      return price;
    }
    await new Promise((r) => setTimeout(r, NO_CONFIRM_POLL_MS));
  }
  return null;
}

function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10);
}

class RiskManager {
  private marketSpent = new Map<string, number>();
  private dailySpent = 0;
  private dailyKey = todayUtcKey();

  private rolloverIfNewDay(): void {
    const key = todayUtcKey();
    if (key !== this.dailyKey) {
      console.log(`📅 Новые сутки (${key}) — лимиты сброшены.`);
      this.dailyKey = key;
      this.dailySpent = 0;
      this.marketSpent.clear();
    }
  }

  canSpend(eventSlug: string, amountUsd: number): { ok: boolean; reason?: string } {
    this.rolloverIfNewDay();
    if (this.dailySpent + amountUsd > MAX_DAILY_TOTAL_USD) {
      return { ok: false, reason: `дневной лимит (${MAX_DAILY_TOTAL_USD}$), потрачено ${this.dailySpent}$` };
    }
    const marketCurrent = this.marketSpent.get(eventSlug) ?? 0;
    if (marketCurrent + amountUsd > MAX_MARKET_EXPOSURE_USD) {
      return { ok: false, reason: `лимит на рынок (${MAX_MARKET_EXPOSURE_USD}$)` };
    }
    return { ok: true };
  }

  record(eventSlug: string, amountUsd: number): void {
    this.rolloverIfNewDay();
    this.dailySpent += amountUsd;
    this.marketSpent.set(eventSlug, (this.marketSpent.get(eventSlug) ?? 0) + amountUsd);
  }

  status(): string {
    return `дневной расход: ${this.dailySpent}/${MAX_DAILY_TOTAL_USD}$`;
  }
}

class StatsTracker {
  private signals: { city: string; bin: string }[] = [];
  private skipped = 0;
  private notConfirmed = 0;

  recordSignal(city: string, bin: string): void {
    this.signals.push({ city, bin });
  }
  recordSkip(): void {
    this.skipped++;
  }
  recordNotConfirmed(): void {
    this.notConfirmed++;
  }

  buildHourlySummary(): string {
    const count = this.signals.length;
    const lines = this.signals.slice(-15).map((s) => `• ${s.city} / ${s.bin}`).join("\n");
    const summary =
      `📊 <b>Сводка за час</b>\nСигналов всего: ${count}\n` +
      `Пропущено (лимиты): ${this.skipped}\nНе подтвердились (NO не дорос до ${MIN_NO_ENTRY_PRICE}): ${this.notConfirmed}\n\n${lines || "(сигналов не было)"}`;
    this.signals = [];
    this.skipped = 0;
    this.notConfirmed = 0;
    return summary;
  }
}

async function handleSignal(
  signal: CrashSignal,
  info: TokenInfo,
  clob: ClobService | null,
  risk: RiskManager,
  telegram: TelegramNotifier | undefined,
  stats: StatsTracker,
) {
  console.log(`\n=== СИГНАЛ: ${info.city} / ${info.binLabel} (${info.eventSlug}) ===`);
  console.log(`YES упал с ${signal.priceBefore} до ${signal.priceNow} за ${signal.windowSec.toFixed(1)}с`);
  stats.recordSignal(info.city, info.binLabel);

  // Справочный контекст от метеостанции — не блокирует, просто логируем/шлём параллельно
  fetchStationContext(info.city).then((ctx) => {
    if (ctx) console.log(`  ℹ️  ${ctx}`);
  });

  console.log(`Ждём подтверждения: NO должен дорасти до ${MIN_NO_ENTRY_PRICE} (максимум ${NO_CONFIRM_TIMEOUT_SEC}с)...`);
  const confirmedPrice = await waitForNoConfirmation(info.noTokenId);

  if (confirmedPrice === null) {
    console.log(`⏭️  ПРОПУСК: NO не дорос до ${MIN_NO_ENTRY_PRICE} за ${NO_CONFIRM_TIMEOUT_SEC}с — слишком рано / слишком рискованно`);
    stats.recordNotConfirmed();
    return;
  }

  console.log(`✅ NO подтверждён на ${confirmedPrice}`);

  const check = risk.canSpend(info.eventSlug, TRADE_SIZE_USD);
  if (!check.ok) {
    console.log(`⛔ ПРОПУСК: ${check.reason}`);
    stats.recordSkip();
    return;
  }

  console.log(`Действие: покупаем NO на ${TRADE_SIZE_USD}$ | ${risk.status()}`);

  const modeTag = DRY_RUN ? "[DRY_RUN] " : "";
  const msg = `${modeTag}🚨 <b>${info.city} / ${info.binLabel}</b>\nYES: ${signal.priceBefore} → ${signal.priceNow} за ${signal.windowSec.toFixed(1)}с\nNO подтверждён на ${confirmedPrice}\nПокупаем на ${TRADE_SIZE_USD}$`;
  await telegram?.send(msg);

  if (DRY_RUN || !clob) {
    console.log("[DRY_RUN] Ордер НЕ отправлен.");
    risk.record(info.eventSlug, TRADE_SIZE_USD);
    return;
  }

  try {
    const buyResp = await clob.placeLimitOrder({
      tokenId: info.noTokenId,
      side: Side.BUY,
      price: confirmedPrice,
      size: TRADE_SIZE_USD,
      maxSlippagePct: MAX_SLIPPAGE_PCT,
    });
    console.log("✅ Вход исполнен:", buyResp);
    risk.record(info.eventSlug, TRADE_SIZE_USD);
    await telegram?.send(`✅ Вход исполнен: ${info.city} / ${info.binLabel}`);

    const filledShares = Number(buyResp.filledSize ?? 0);
    if (filledShares > 0) {
      const sellResp = await clob.placeGtcLimitOrder({
        tokenId: info.noTokenId,
        side: Side.SELL,
        price: 0.999,
        size: filledShares,
        offsetPct: 0,
      });
      console.log("✅ Выходная лимитка выставлена:", sellResp);
      await telegram?.send(`📤 Лимитка на выход 0.999 выставлена: ${info.city} / ${info.binLabel}`);
    }
  } catch (err) {
    console.error("❌ Ошибка исполнения:", (err as Error).message);
    await telegram?.send(`❌ Ошибка исполнения: ${info.city} / ${info.binLabel}\n${(err as Error).message}`);
  }
}

async function main() {
  console.log(`Режим: ${DRY_RUN ? "DRY_RUN (без реальных сделок)" : "⚠️  LIVE — РЕАЛЬНЫЕ ДЕНЬГИ"}`);
  console.log(`Лимиты: ${TRADE_SIZE_USD}$/сделка, ${MAX_MARKET_EXPOSURE_USD}$/рынок/день, ${MAX_DAILY_TOTAL_USD}$/всего/день`);
  console.log(`Порог входа NO: ${MIN_NO_ENTRY_PRICE}, таймаут подтверждения: ${NO_CONFIRM_TIMEOUT_SEC}с`);

  const logger: Logger = createLogger(false);
  const telegram = createTelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, logger);
  if (telegram) {
    console.log("Telegram уведомления включены.");
    await telegram.send(`🤖 Бот запущен. Режим: ${DRY_RUN ? "DRY_RUN" : "LIVE"}`);
  } else {
    console.log("Telegram НЕ настроен — уведомлений не будет.");
  }

  console.log("Загружаем список рынков (только highest, только сегодня)...");
  const markets = await discoverWeatherMarkets();
  const tokenIndex = buildTokenIndex(markets);
  const yesTokenIds = [...tokenIndex.keys()];
  console.log(`Мониторим ${markets.length} рынков, ${yesTokenIds.length} YES-токенов`);
  console.log("Города:", markets.map((m) => m.city).join(", "));

  let clob: ClobService | null = null;
  if (!DRY_RUN) {
    clob = await ClobService.init(
      {
        host: process.env.CLOB_HOST ?? "https://clob.polymarket.com",
        rpcUrl: process.env.RPC_URL,
        chainId: Number(process.env.CHAIN_ID ?? "137"),
        privateKey: process.env.PRIVATE_KEY!,
        signatureType: Number(process.env.SIGNATURE_TYPE ?? "1"),
        funderAddress: process.env.FUNDER_ADDRESS,
      },
      logger,
    );
    console.log("ClobService инициализирован для LIVE торговли.");
  }

  const detector = new CrashDetector();
  const risk = new RiskManager();
  const stats = new StatsTracker();

  const watcher = new PriceWatcher(yesTokenIds, async (update: PriceUpdate) => {
    const signal = detector.onPriceUpdate(update);
    if (!signal) return;
    const info = tokenIndex.get(signal.tokenId);
    if (!info) return;
    await handleSignal(signal, info, clob, risk, telegram, stats);
  });

  watcher.start();

  setInterval(async () => {
    if (!telegram) return;
    await telegram.send(stats.buildHourlySummary());
  }, 60 * 60 * 1000);
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
  process.exit(1);
});
