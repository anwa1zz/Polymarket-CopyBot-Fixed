/**
 * Детектор обвала YES -> покупка NO -> risk-лимиты -> уведомления в Telegram.
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

interface TokenInfo {
  yesTokenId: string;
  noTokenId: string;
  city: string;
  binLabel: string;
  eventSlug: string;
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

// Простая статистика для часовой сводки в Telegram
class StatsTracker {
  private signals: { city: string; bin: string; time: number }[] = [];
  private skipped = 0;

  recordSignal(city: string, bin: string): void {
    this.signals.push({ city, bin, time: Date.now() });
  }

  recordSkip(): void {
    this.skipped++;
  }

  buildHourlySummary(): string {
    const count = this.signals.length;
    const lines = this.signals
      .slice(-15) // последние 15, чтобы сообщение не было гигантским
      .map((s) => `• ${s.city} / ${s.bin}`)
      .join("\n");
    const summary = `📊 <b>Сводка за час</b>\nСигналов: ${count}\nПропущено (лимиты): ${this.skipped}\n\n${lines || "(сигналов не было)"}`;
    this.signals = [];
    this.skipped = 0;
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
  const buyTokenId = info.noTokenId;

  console.log(`\n=== СИГНАЛ: ${info.city} / ${info.binLabel} (${info.eventSlug}) ===`);
  console.log(`YES упал с ${signal.priceBefore} до ${signal.priceNow} за ${signal.windowSec.toFixed(1)}с`);

  stats.recordSignal(info.city, info.binLabel);

  const check = risk.canSpend(info.eventSlug, TRADE_SIZE_USD);
  if (!check.ok) {
    console.log(`⛔ ПРОПУСК: ${check.reason}`);
    stats.recordSkip();
    return;
  }

  console.log(`Действие: покупаем NO на ${TRADE_SIZE_USD}$ | ${risk.status()}`);

  const modeTag = DRY_RUN ? "[DRY_RUN] " : "";
  const msg = `${modeTag}🚨 <b>${info.city} / ${info.binLabel}</b>\nYES: ${signal.priceBefore} → ${signal.priceNow} за ${signal.windowSec.toFixed(1)}с\nПокупаем NO на ${TRADE_SIZE_USD}$`;
  await telegram?.send(msg);

  if (DRY_RUN || !clob) {
    console.log("[DRY_RUN] Ордер НЕ отправлен.");
    risk.record(info.eventSlug, TRADE_SIZE_USD);
    return;
  }

  try {
    const buyResp = await clob.placeLimitOrder({
      tokenId: buyTokenId,
      side: Side.BUY,
      price: signal.priceNow,
      size: TRADE_SIZE_USD,
      maxSlippagePct: MAX_SLIPPAGE_PCT,
    });
    console.log("✅ Вход исполнен:", buyResp);
    risk.record(info.eventSlug, TRADE_SIZE_USD);
    await telegram?.send(`✅ Вход исполнен: ${info.city} / ${info.binLabel}`);

    const filledShares = Number(buyResp.filledSize ?? 0);
    if (filledShares > 0) {
      const sellResp = await clob.placeGtcLimitOrder({
        tokenId: buyTokenId,
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

  const logger: Logger = createLogger(false);
  const telegram = createTelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, logger);
  if (telegram) {
    console.log("Telegram уведомления включены.");
    await telegram.send(`🤖 Бот запущен. Режим: ${DRY_RUN ? "DRY_RUN" : "LIVE"}`);
  } else {
    console.log("Telegram НЕ настроен (нет TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — уведомлений не будет.");
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

  // Часовая сводка в Telegram
  setInterval(async () => {
    if (!telegram) return;
    await telegram.send(stats.buildHourlySummary());
  }, 60 * 60 * 1000);
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
  process.exit(1);
});
