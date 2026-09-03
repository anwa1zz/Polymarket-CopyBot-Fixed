/**
 * Максимально простая логика:
 * 1. Следим за ценой NO-токена каждого температурного бина.
 * 2. Как только цена NO впервые пересекает 0.995 (снизу вверх) — сразу
 *    покупаем по рынку.
 * 3. Сразу после покупки выставляем лимитку на продажу по 0.999.
 * Никакого анализа YES, никакого ожидания подтверждения — прямая реакция.
 */

import "dotenv/config";
import { Side } from "@polymarket/clob-client-v2";
import { discoverWeatherMarkets, WeatherMarket } from "./marketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { ClobService } from "./clob.js";
import { createLogger, Logger } from "./logger.js";
import { createTelegramNotifier, TelegramNotifier } from "./telegram.js";
import { ExitManager } from "./exitManager.js";

const DRY_RUN = (process.env.W995_DRY_RUN ?? "true").toLowerCase() !== "false";
const TRADE_SIZE_USD = Number(process.env.W995_TRADE_SIZE_USD ?? "5");
const MAX_SLIPPAGE_PCT = Number(process.env.W995_MAX_SLIPPAGE_PCT ?? "1");
const ENTRY_PRICE = Number(process.env.W995_ENTRY_PRICE ?? "0.995");
const EXIT_PRICE = Number(process.env.W995_EXIT_PRICE ?? "0.999");

interface TokenInfo {
  city: string;
  binLabel: string;
  eventSlug: string;
}

function buildTokenIndex(markets: WeatherMarket[]): Map<string, TokenInfo> {
  const index = new Map<string, TokenInfo>();
  for (const m of markets) {
    for (const b of m.bins) {
      // следим именно за NO-токеном напрямую
      index.set(b.noTokenId, { city: m.city, binLabel: b.label, eventSlug: m.eventSlug });
    }
  }
  return index;
}

async function handleCrossing(
  tokenId: string,
  price: number,
  info: TokenInfo,
  clob: ClobService | null,
  telegram: TelegramNotifier | undefined,
  exitManager: ExitManager | null,
) {
  console.log(`\n=== ${info.city} / ${info.binLabel}: NO дошёл до ${price} ===`);

  const modeTag = DRY_RUN ? "[DRY_RUN] " : "";
  await telegram?.send(`${modeTag}🎯 <b>${info.city} / ${info.binLabel}</b>\nNO достиг ${price}\nПокупаем на ${TRADE_SIZE_USD}$`);

  if (DRY_RUN || !clob) {
    console.log("[DRY_RUN] Ордер НЕ отправлен.");
    return;
  }

  try {
    const buyResp = await clob.placeLimitOrder({
      tokenId,
      side: Side.BUY,
      price,
      size: TRADE_SIZE_USD,
      maxSlippagePct: MAX_SLIPPAGE_PCT,
    });
    console.log("✅ Вход исполнен:", buyResp);
    await telegram?.send(`✅ Вход исполнен: ${info.city} / ${info.binLabel}`);

    const filledShares = Number(buyResp.filledSize ?? 0);
    if (filledShares > 0) {
      const sellResp = await clob.placeGtcLimitOrder({
        tokenId,
        side: Side.SELL,
        price: EXIT_PRICE,
        size: filledShares,
        offsetPct: 0,
      });
      console.log("✅ Выходная лимитка выставлена:", sellResp);
      await telegram?.send(`📤 Лимитка на выход ${EXIT_PRICE} выставлена: ${info.city} / ${info.binLabel}`);

      if (exitManager && sellResp.orderId) {
        exitManager.watch({
          orderId: sellResp.orderId,
          tokenId,
          city: info.city,
          binLabel: info.binLabel,
          originalSize: filledShares,
          startedAt: Date.now(),
        });
      }
    }
  } catch (err) {
    console.error("❌ Ошибка исполнения:", (err as Error).message);
    await telegram?.send(`❌ Ошибка: ${info.city} / ${info.binLabel}\n${(err as Error).message}`);
  }
}

async function main() {
  console.log(`Режим: ${DRY_RUN ? "DRY_RUN (без реальных сделок)" : "⚠️  LIVE — РЕАЛЬНЫЕ ДЕНЬГИ"}`);
  console.log(`Простая логика: NO пересёк ${ENTRY_PRICE} → покупка $${TRADE_SIZE_USD} → продажа по ${EXIT_PRICE}`);

  const logger: Logger = createLogger(false);
  const telegram = createTelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, logger);
  if (telegram) {
    await telegram.send(`🤖 Простой бот (NO ${ENTRY_PRICE} → ${EXIT_PRICE}) запущен. Режим: ${DRY_RUN ? "DRY_RUN" : "LIVE"}`);
  }

  console.log("Загружаем список рынков (только highest, только сегодня)...");
  const markets = await discoverWeatherMarkets();
  const tokenIndex = buildTokenIndex(markets);
  const noTokenIds = [...tokenIndex.keys()];
  console.log(`Мониторим ${markets.length} рынков, ${noTokenIds.length} NO-токенов`);
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
  }

  // помним, по каким токенам уже сработал сигнал, чтобы не покупать повторно один и тот же бин
  const alreadyBought = new Set<string>();

  const watcher = new PriceWatcher(noTokenIds, async (update: PriceUpdate) => {
    const price = update.bestAsk;
    if (price === null) return;
    if (price < ENTRY_PRICE) return;
    if (alreadyBought.has(update.tokenId)) return;

    const info = tokenIndex.get(update.tokenId);
    if (!info) return;

    alreadyBought.add(update.tokenId);
    await handleCrossing(update.tokenId, price, info, clob, telegram, exitManager);
  });

  watcher.start();
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
  process.exit(1);
});
