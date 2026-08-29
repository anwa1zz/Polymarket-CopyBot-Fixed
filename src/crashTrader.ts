/**
 * Модуль 4 + 6: детектор обвала -> исполнение ордеров -> риск-лимиты.
 * DRY_RUN управляется через переменную окружения — по умолчанию true (безопасно).
 */

import "dotenv/config";
import { Side } from "@polymarket/clob-client-v2";
import { discoverWeatherMarkets, WeatherMarket } from "./marketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { CrashDetector, CrashSignal } from "./crashDetector.js";
import { ClobService } from "./clob.js";
import { createLogger, Logger } from "./logger.js";

const DRY_RUN = (process.env.CRASH_DRY_RUN ?? "true").toLowerCase() !== "false";
const TRADE_SIZE_USD = Number(process.env.CRASH_TRADE_SIZE_USD ?? "5");
const MAX_SLIPPAGE_PCT = Number(process.env.CRASH_MAX_SLIPPAGE_PCT ?? "1");
const MAX_MARKET_EXPOSURE_USD = Number(process.env.CRASH_MAX_MARKET_EXPOSURE_USD ?? "15");
const MAX_DAILY_TOTAL_USD = Number(process.env.CRASH_MAX_DAILY_TOTAL_USD ?? "100");
// ^ общий потолок на ВСЕ сделки за календарные сутки (UTC), не только на один рынок

interface TokenInfo {
  tokenId: string;
  side: "YES" | "NO";
  pairTokenId: string;
  city: string;
  binLabel: string;
  eventSlug: string;
}

function buildTokenIndex(markets: WeatherMarket[]): Map<string, TokenInfo> {
  const index = new Map<string, TokenInfo>();
  for (const m of markets) {
    for (const b of m.bins) {
      index.set(b.yesTokenId, { tokenId: b.yesTokenId, side: "YES", pairTokenId: b.noTokenId, city: m.city, binLabel: b.label, eventSlug: m.eventSlug });
      index.set(b.noTokenId, { tokenId: b.noTokenId, side: "NO", pairTokenId: b.yesTokenId, city: m.city, binLabel: b.label, eventSlug: m.eventSlug });
    }
  }
  return index;
}

function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10); // "2026-08-29"
}

class RiskManager {
  private marketSpent = new Map<string, number>();
  private dailySpent = 0;
  private dailyKey = todayUtcKey();

  private rolloverIfNewDay(): void {
    const key = todayUtcKey();
    if (key !== this.dailyKey) {
      console.log(`📅 Новые сутки (${key}) — дневной лимит и лимиты по рынкам сброшены.`);
      this.dailyKey = key;
      this.dailySpent = 0;
      this.marketSpent.clear();
    }
  }

  canSpend(eventSlug: string, amountUsd: number): { ok: boolean; reason?: string } {
    this.rolloverIfNewDay();

    if (this.dailySpent + amountUsd > MAX_DAILY_TOTAL_USD) {
      return { ok: false, reason: `превышен общий дневной лимит (${MAX_DAILY_TOTAL_USD}$), уже потрачено ${this.dailySpent}$` };
    }
    const marketCurrent = this.marketSpent.get(eventSlug) ?? 0;
    if (marketCurrent + amountUsd > MAX_MARKET_EXPOSURE_USD) {
      return { ok: false, reason: `превышен лимит на этот рынок (${MAX_MARKET_EXPOSURE_USD}$)` };
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

async function handleSignal(
  signal: CrashSignal,
  info: TokenInfo,
  clob: ClobService | null,
  risk: RiskManager,
) {
  const buyTokenId = info.pairTokenId;

  console.log(`\n=== СИГНАЛ: ${info.city} / ${info.binLabel} (${info.eventSlug}) ===`);
  console.log(`YES упал с ${signal.priceBefore} до ${signal.priceNow} за ${signal.windowSec.toFixed(1)}с`);

  const check = risk.canSpend(info.eventSlug, TRADE_SIZE_USD);
  if (!check.ok) {
    console.log(`⛔ ПРОПУСК: ${check.reason}`);
    return;
  }

  console.log(`Действие: покупаем NO (token=${buyTokenId.slice(0, 16)}...) на ${TRADE_SIZE_USD}$ | ${risk.status()}`);

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
    }
  } catch (err) {
    console.error("❌ Ошибка исполнения:", (err as Error).message);
  }
}

async function main() {
  console.log(`Режим: ${DRY_RUN ? "DRY_RUN (без реальных сделок)" : "⚠️  LIVE — РЕАЛЬНЫЕ ДЕНЬГИ"}`);
  console.log(`Лимиты: ${TRADE_SIZE_USD}$/сделка, ${MAX_MARKET_EXPOSURE_USD}$/рынок/день, ${MAX_DAILY_TOTAL_USD}$/всего/день`);

  console.log("Загружаем список рынков...");
  const markets = await discoverWeatherMarkets();
  const tokenIndex = buildTokenIndex(markets);
  const allTokenIds = [...tokenIndex.keys()];
  console.log(`Мониторим ${markets.length} рынков, ${allTokenIds.length} токенов`);

  let clob: ClobService | null = null;
  if (!DRY_RUN) {
    const logger: Logger = createLogger(false);
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

  const watcher = new PriceWatcher(allTokenIds, async (update: PriceUpdate) => {
    const signal = detector.onPriceUpdate(update);
    if (!signal) return;
    const info = tokenIndex.get(signal.tokenId);
    if (!info) return;
    await handleSignal(signal, info, clob, risk);
  });

  watcher.start();
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
  process.exit(1);
});
