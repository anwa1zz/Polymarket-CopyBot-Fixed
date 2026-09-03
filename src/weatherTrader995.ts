/**
 * Погодный бот с порогом входа 0.995 (по данным статистики — 0% разворотов
 * на 500 наблюдениях, против 1-2% на более низких порогах).
 * БЕЗ дневных лимитов на сумму/число сделок — торгует по факту каждого сигнала.
 * Логика идентична crashTrader.ts, только порог входа и без RiskManager.
 */

import "dotenv/config";
import { Side } from "@polymarket/clob-client-v2";
import { discoverWeatherMarkets, WeatherMarket } from "./marketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { CrashDetector, CrashSignal } from "./crashDetector.js";
import { ClobService } from "./clob.js";
import { createLogger, Logger } from "./logger.js";
import { createTelegramNotifier, TelegramNotifier } from "./telegram.js";
import { fetchWeatherContext } from "./weatherContext.js";
import { ExitManager } from "./exitManager.js";

const DRY_RUN = (process.env.W995_DRY_RUN ?? "true").toLowerCase() !== "false";
const TRADE_SIZE_USD = Number(process.env.W995_TRADE_SIZE_USD ?? "5");
const MAX_SLIPPAGE_PCT = Number(process.env.W995_MAX_SLIPPAGE_PCT ?? "1");
const MIN_NO_ENTRY_PRICE = Number(process.env.W995_MIN_NO_ENTRY_PRICE ?? "0.995");
const NO_CONFIRM_TIMEOUT_SEC = Number(process.env.W995_NO_CONFIRM_TIMEOUT_SEC ?? "15");
const NO_CONFIRM_POLL_MS = 1000;

interface TokenInfo {
  yesTokenId: string;
  noTokenId: string;
  city: string;
  binLabel: string;
  eventSlug: string;
  resolutionSource: string;
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
        resolutionSource: m.resolutionSource,
      });
    }
  }
  return index;
}

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

async function waitForNoConfirmation(noTokenId: string): Promise<number | null> {
  const deadline = Date.now() + NO_CONFIRM_TIMEOUT_SEC * 1000;
  while (Date.now() < deadline) {
    const price = await getLiveBestAsk(noTokenId);
    if (price !== null && price >= MIN_NO_ENTRY_PRICE) return price;
    await new Promise((r) => setTimeout(r, NO_CONFIRM_POLL_MS));
  }
  return null;
}

async function handleSignal(
  signal: CrashSignal,
  info: TokenInfo,
  clob: ClobService | null,
  telegram: TelegramNotifier | undefined,
  exitManager: ExitManager | null,
) {
  console.log(`\n=== СИГНАЛ: ${info.city} / ${info.binLabel} (${info.eventSlug}) ===`);
  console.log(`YES упал с ${signal.priceBefore} до ${signal.priceNow} за ${signal.windowSec.toFixed(1)}с`);

  fetchWeatherContext(info.city, info.resolutionSource).then((ctx) => {
    if (ctx) console.log(`  ℹ️  ${ctx}`);
  });

  console.log(`Ждём подтверждения: NO должен дорасти до ${MIN_NO_ENTRY_PRICE} (максимум ${NO_CONFIRM_TIMEOUT_SEC}с)...`);
  const confirmedPrice = await waitForNoConfirmation(info.noTokenId);

  if (confirmedPrice === null) {
    console.log(`⏭️  ПРОПУСК: NO не дорос до ${MIN_NO_ENTRY_PRICE} за ${NO_CONFIRM_TIMEOUT_SEC}с`);
    return;
  }
  console.log(`✅ NO подтверждён на ${confirmedPrice}`);

  const modeTag = DRY_RUN ? "[DRY_RUN] " : "";
  const msg = `${modeTag}🚨 <b>${info.city} / ${info.binLabel}</b>\nYES: ${signal.priceBefore} → ${signal.priceNow} за ${signal.windowSec.toFixed(1)}с\nNO подтверждён на ${confirmedPrice}\nПокупаем на ${TRADE_SIZE_USD}$`;
  await telegram?.send(msg);

  if (DRY_RUN || !clob) {
    console.log("[DRY_RUN] Ордер НЕ отправлен.");
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

      if (exitManager && sellResp.orderId) {
        exitManager.watch({
          orderId: sellResp.orderId,
          tokenId: info.noTokenId,
          city: info.city,
          binLabel: info.binLabel,
          originalSize: filledShares,
          startedAt: Date.now(),
        });
      }
    }
  } catch (err) {
    console.error("❌ Ошибка исполнения:", (err as Error).message);
    await telegram?.send(`❌ Ошибка исполнения: ${info.city} / ${info.binLabel}\n${(err as Error).message}`);
  }
}

async function main() {
  console.log(`Режим: ${DRY_RUN ? "DRY_RUN (без реальных сделок)" : "⚠️  LIVE — РЕАЛЬНЫЕ ДЕНЬГИ"}`);
  console.log(`Размер сделки: ${TRADE_SIZE_USD}$, без дневных лимитов`);
  console.log(`Порог входа NO: ${MIN_NO_ENTRY_PRICE}, таймаут подтверждения: ${NO_CONFIRM_TIMEOUT_SEC}с`);

  const logger: Logger = createLogger(false);
  const telegram = createTelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, logger);
  if (telegram) {
    console.log("Telegram уведомления включены.");
    await telegram.send(`🤖 Бот (порог 0.995) запущен. Режим: ${DRY_RUN ? "DRY_RUN" : "LIVE"}`);
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
  let exitManager: ExitManager | null = null;
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
    exitManager = new ExitManager(clob, telegram);
    exitManager.start();
    console.log("Exit Manager запущен.");
  }

  const detector = new CrashDetector();

  const watcher = new PriceWatcher(yesTokenIds, async (update: PriceUpdate) => {
    const signal = detector.onPriceUpdate(update);
    if (!signal) return;
    const info = tokenIndex.get(signal.tokenId);
    if (!info) return;
    await handleSignal(signal, info, clob, telegram, exitManager);
  });

  watcher.start();
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
  process.exit(1);
});
