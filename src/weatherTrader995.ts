/**
 * Простая логика: NO пересёк 0.995 -> покупка по рынку -> лимитка на 0.999.
 * В Telegram шлём ТОЛЬКО одно сообщение — когда сделка реально закрылась
 * (позиция продана), с расчётом профита. Никаких промежуточных уведомлений.
 */

import "dotenv/config";
import { Side } from "@polymarket/clob-client-v2";
import { discoverWeatherMarkets, WeatherMarket } from "./marketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { ClobService } from "./clob.js";
import { createLogger, Logger } from "./logger.js";
import { createTelegramNotifier, TelegramNotifier } from "./telegram.js";

const DRY_RUN = (process.env.W995_DRY_RUN ?? "true").toLowerCase() !== "false";
const TRADE_SIZE_USD = Number(process.env.W995_TRADE_SIZE_USD ?? "5");
const MAX_SLIPPAGE_PCT = Number(process.env.W995_MAX_SLIPPAGE_PCT ?? "1");
const ENTRY_PRICE = Number(process.env.W995_ENTRY_PRICE ?? "0.995");
const EXIT_PRICE = Number(process.env.W995_EXIT_PRICE ?? "0.999");
const EXIT_TIMEOUT_MIN = Number(process.env.W995_EXIT_TIMEOUT_MIN ?? "20");
const EXIT_CHECK_INTERVAL_MS = 60 * 1000;

interface TokenInfo {
  city: string;
  binLabel: string;
  eventSlug: string;
}

interface WatchedPosition {
  orderId: string;
  tokenId: string;
  city: string;
  binLabel: string;
  filledSize: number;
  buyPrice: number;
  startedAt: number;
}

function buildTokenIndex(markets: WeatherMarket[]): Map<string, TokenInfo> {
  const index = new Map<string, TokenInfo>();
  for (const m of markets) {
    for (const b of m.bins) {
      index.set(b.noTokenId, { city: m.city, binLabel: b.label, eventSlug: m.eventSlug });
    }
  }
  return index;
}

/** Следит за выставленной лимиткой на выход. При исполнении (полном или частичном по таймауту) — считает профит и шлёт ОДНО сообщение. */
class PositionTracker {
  private watched: WatchedPosition[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private clob: ClobService, private telegram: TelegramNotifier | undefined) {}

  start(): void {
    this.timer = setInterval(() => this.checkAll(), EXIT_CHECK_INTERVAL_MS);
  }

  watch(pos: WatchedPosition): void {
    this.watched.push(pos);
  }

  private async checkAll(): Promise<void> {
    const stillWatching: WatchedPosition[] = [];

    for (const pos of this.watched) {
      try {
        const order = await this.clob.getOrder(pos.orderId);
        const matched = Number((order as any)?.size_matched ?? 0);
        const fullyFilled = matched >= pos.filledSize - 0.0001;

        if (fullyFilled && matched > 0) {
          await this.closeAndNotify(pos, matched, EXIT_PRICE, "лимитка 0.999");
          continue;
        }

        const elapsed = Date.now() - pos.startedAt;
        if (elapsed < EXIT_TIMEOUT_MIN * 60 * 1000) {
          stillWatching.push(pos);
          continue;
        }

        // таймаут — закрываем остаток по рынку
        const remaining = pos.filledSize - matched;
        try {
          await this.clob.cancelOrders([pos.orderId]);
        } catch {
          // не критично, продолжаем
        }

        if (remaining > 0.0001) {
          try {
            const resp = await this.clob.placeLimitOrder({
              tokenId: pos.tokenId,
              side: Side.SELL,
              price: 0.5, // fallback, реальная цена берётся из живого стакана
              size: remaining,
              maxSlippagePct: 5,
            });
            const soldPrice = Number(resp.filledUsdc ?? 0) / Number(resp.filledSize || remaining);
            const totalMatched = matched + Number(resp.filledSize ?? remaining);
            const avgExitPrice = matched > 0
              ? (matched * EXIT_PRICE + Number(resp.filledSize ?? remaining) * soldPrice) / totalMatched
              : soldPrice;
            await this.closeAndNotify(pos, totalMatched, avgExitPrice, "закрыто по рынку (таймаут)");
          } catch (err) {
            console.error(`❌ Не удалось закрыть остаток по рынку: ${(err as Error).message}`);
            await this.telegram?.send(`❌ ОШИБКА закрытия позиции: ${pos.city} / ${pos.binLabel}\n${(err as Error).message}\n⚠️ Требуется ручная проверка!`);
          }
        } else {
          await this.closeAndNotify(pos, matched, EXIT_PRICE, "лимитка 0.999 (частично)");
        }
      } catch (err) {
        console.warn(`Ошибка проверки позиции ${pos.orderId.slice(0, 12)}...: ${(err as Error).message}`);
        stillWatching.push(pos);
      }
    }

    this.watched = stillWatching;
  }

  private async closeAndNotify(pos: WatchedPosition, soldSize: number, exitPrice: number, how: string): Promise<void> {
    const profit = soldSize * (exitPrice - pos.buyPrice);
    const profitPct = ((exitPrice - pos.buyPrice) / pos.buyPrice) * 100;
    const sign = profit >= 0 ? "✅" : "🔻";
    const msg =
      `${sign} <b>Сделка закрыта</b> (${how})\n` +
      `${pos.city} / ${pos.binLabel}\n` +
      `Вход: ${pos.buyPrice} → Выход: ${exitPrice.toFixed(4)}\n` +
      `Объём: ${soldSize.toFixed(2)} акций\n` +
      `Профит: ${profit >= 0 ? "+" : ""}$${profit.toFixed(3)} (${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(2)}%)`;
    console.log(`\n${msg.replace(/<\/?b>/g, "")}\n`);
    await this.telegram?.send(msg);
  }
}

async function handleCrossing(
  tokenId: string,
  price: number,
  info: TokenInfo,
  clob: ClobService | null,
  tracker: PositionTracker | null,
) {
  console.log(`\n=== ${info.city} / ${info.binLabel}: NO дошёл до ${price} ===`);

  if (DRY_RUN || !clob) {
    console.log("[DRY_RUN] Ордер НЕ отправлен (уведомление в Telegram придёт только на реальной сделке).");
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

    const filledShares = Number(buyResp.filledSize ?? 0);
    const actualBuyPrice = Number(buyResp.filledUsdc ?? 0) / (filledShares || 1) || price;

    if (filledShares > 0) {
      const sellResp = await clob.placeGtcLimitOrder({
        tokenId,
        side: Side.SELL,
        price: EXIT_PRICE,
        size: filledShares,
        offsetPct: 0,
      });
      console.log("✅ Выходная лимитка выставлена:", sellResp);

      if (tracker && sellResp.orderId) {
        tracker.watch({
          orderId: sellResp.orderId,
          tokenId,
          city: info.city,
          binLabel: info.binLabel,
          filledSize: filledShares,
          buyPrice: actualBuyPrice,
          startedAt: Date.now(),
        });
      }
    }
  } catch (err) {
    console.error("❌ Ошибка исполнения:", (err as Error).message);
  }
}

async function main() {
  console.log(`Режим: ${DRY_RUN ? "DRY_RUN (без реальных сделок)" : "⚠️  LIVE — РЕАЛЬНЫЕ ДЕНЬГИ"}`);
  console.log(`NO пересёк ${ENTRY_PRICE} → покупка $${TRADE_SIZE_USD} → продажа по ${EXIT_PRICE}`);
  console.log(`Telegram: только уведомления о закрытых сделках с профитом`);

  const logger: Logger = createLogger(false);
  const telegram = createTelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, logger);
  if (telegram) {
    console.log("Telegram настроен (сообщения только при закрытии сделки).");
  }

  console.log("Загружаем список рынков (только highest, только сегодня)...");
  const markets = await discoverWeatherMarkets();
  const tokenIndex = buildTokenIndex(markets);
  const noTokenIds = [...tokenIndex.keys()];
  console.log(`Мониторим ${markets.length} рынков, ${noTokenIds.length} NO-токенов`);
  console.log("Города:", markets.map((m) => m.city).join(", "));

  let clob: ClobService | null = null;
  let tracker: PositionTracker | null = null;
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
    tracker = new PositionTracker(clob, telegram);
    tracker.start();
  }

  const alreadyBought = new Set<string>();

  const watcher = new PriceWatcher(noTokenIds, async (update: PriceUpdate) => {
    const price = update.bestAsk;
    if (price === null) return;
    if (price < ENTRY_PRICE) return;
    if (alreadyBought.has(update.tokenId)) return;

    const info = tokenIndex.get(update.tokenId);
    if (!info) return;

    alreadyBought.add(update.tokenId);
    await handleCrossing(update.tokenId, price, info, clob, tracker);
  });

  watcher.start();
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
  process.exit(1);
});
