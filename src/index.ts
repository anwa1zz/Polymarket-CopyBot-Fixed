/**
 * Логика:
 *
 * NO дошёл до 0.995
 *        ↓
 * BUY LIMIT 0.995
 *        ↓
 * ждём реального исполнения BUY
 *        ↓
 * SELL LIMIT 0.999
 *        ↓
 * ждём реального исполнения SELL
 *        ↓
 * одно сообщение в Telegram с профитом
 *
 * ВАЖНО:
 * Никаких Market/FAK ордеров.
 * Вход и выход — только GTC LIMIT.
 */

import "dotenv/config";

import { Side } from "@polymarket/clob-client-v2";

import { discoverWeatherMarkets, WeatherMarket } from "./marketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { ClobService } from "./clob.js";
import { createLogger, Logger } from "./logger.js";
import {
  createTelegramNotifier,
  TelegramNotifier,
} from "./telegram.js";

const DRY_RUN =
  (process.env.W995_DRY_RUN ?? "true").toLowerCase() !== "false";

const TRADE_SIZE_USD = Number(
  process.env.W995_TRADE_SIZE_USD ?? "5",
);

const ENTRY_PRICE = Number(
  process.env.W995_ENTRY_PRICE ?? "0.995",
);

const EXIT_PRICE = Number(
  process.env.W995_EXIT_PRICE ?? "0.999",
);

const CHECK_INTERVAL_MS = 60 * 1000;

const BUY_TIMEOUT_MIN = Number(
  process.env.W995_BUY_TIMEOUT_MIN ?? "20",
);

interface TokenInfo {
  city: string;
  binLabel: string;
  eventSlug: string;
}

interface PendingBuy {
  orderId: string;
  tokenId: string;
  city: string;
  binLabel: string;
  requestedShares: number;
  startedAt: number;
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

function buildTokenIndex(
  markets: WeatherMarket[],
): Map<string, TokenInfo> {
  const index = new Map<string, TokenInfo>();

  for (const m of markets) {
    for (const b of m.bins) {
      index.set(b.noTokenId, {
        city: m.city,
        binLabel: b.label,
        eventSlug: m.eventSlug,
      });
    }
  }

  return index;
}

/**
 * Следит:
 *
 * 1. BUY LIMIT — пока не исполнится.
 * 2. После исполнения BUY — выставляет SELL LIMIT 0.999.
 * 3. После исполнения SELL — отправляет ОДНО сообщение Telegram.
 *
 * Рыночных ордеров здесь НЕТ.
 */
class PositionTracker {
  private pendingBuys: PendingBuy[] = [];
  private positions: WatchedPosition[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private clob: ClobService,
    private telegram: TelegramNotifier | undefined,
  ) {}

  start(): void {
    this.timer = setInterval(
      () => {
        void this.checkAll();
      },
      CHECK_INTERVAL_MS,
    );
  }

  watchBuy(pos: PendingBuy): void {
    this.pendingBuys.push(pos);
  }

  private async checkAll(): Promise<void> {
    await this.checkBuys();
    await this.checkPositions();
  }

  /**
   * Проверяем BUY LIMIT.
   */
  private async checkBuys(): Promise<void> {
    const stillWaiting: PendingBuy[] = [];

    for (const buy of this.pendingBuys) {
      try {
        const order = await this.clob.getOrder(buy.orderId);

        const matched = Number(
          (order as any)?.size_matched ?? 0,
        );

        const status = String(
          (order as any)?.status ?? "",
        ).toLowerCase();

        /**
         * BUY полностью исполнен.
         */
        if (
          matched >= buy.requestedShares - 0.0001 &&
          matched > 0
        ) {
          const makingAmount = Number(
            (order as any)?.making_amount ?? 0,
          );

          const takingAmount = Number(
            (order as any)?.taking_amount ?? 0,
          );

          const actualBuyPrice =
            takingAmount > 0 && makingAmount > 0
              ? takingAmount / makingAmount
              : ENTRY_PRICE;

          console.log(
            `\n✅ BUY исполнен: ${buy.city} / ${buy.binLabel}`,
          );

          console.log(
            `Куплено: ${matched.toFixed(4)} акций`,
          );

          console.log(
            `Средняя цена покупки: ${actualBuyPrice.toFixed(4)}`,
          );

          /**
           * Теперь выставляем SELL LIMIT 0.999.
           */
          try {
            const sellResp =
              await this.clob.placeGtcLimitOrder({
                tokenId: buy.tokenId,
                side: Side.SELL,
                price: EXIT_PRICE,
                size: matched,
                offsetPct: 0,
              });

            console.log(
              `✅ SELL LIMIT ${EXIT_PRICE} выставлен`,
              sellResp,
            );

            if (sellResp.orderId) {
              this.positions.push({
                orderId: sellResp.orderId,
                tokenId: buy.tokenId,
                city: buy.city,
                binLabel: buy.binLabel,
                filledSize: matched,
                buyPrice: actualBuyPrice,
                startedAt: Date.now(),
              });
            }
          } catch (err) {
            console.error(
              `❌ Не удалось выставить SELL LIMIT: ${
                (err as Error).message
              }`,
            );
          }

          continue;
        }

        /**
         * BUY частично исполнился.
         *
         * Если часть уже куплена, пока не считаем сделку закрытой.
         * Оставшийся BUY продолжает висеть.
         */
        if (matched > 0) {
          console.log(
            `⏳ BUY частично исполнен: ${buy.city} / ${buy.binLabel} — ${matched.toFixed(4)} акций`,
          );

          stillWaiting.push(buy);
          continue;
        }

        /**
         * Если ордер отменён/закрыт и ничего не куплено —
         * просто перестаём его отслеживать.
         */
        if (
          status.includes("cancel") ||
          status.includes("expired")
        ) {
          console.log(
            `ℹ️ BUY ордер больше не активен: ${buy.city} / ${buy.binLabel}`,
          );
          continue;
        }

        /**
         * Таймаут BUY.
         *
         * Мы НЕ продаём по рынку.
         * Просто отменяем невыполненный лимитный BUY.
         */
        const elapsed =
          Date.now() - buy.startedAt;

        if (
          elapsed >=
          BUY_TIMEOUT_MIN * 60 * 1000
        ) {
          console.log(
            `⏰ BUY LIMIT не исполнился за ${BUY_TIMEOUT_MIN} мин — отменяем.`,
          );

          try {
            await this.clob.cancelOrders([
              buy.orderId,
            ]);
          } catch (err) {
            console.warn(
              `⚠️ Не удалось отменить BUY: ${
                (err as Error).message
              }`,
            );
          }

          continue;
        }

        stillWaiting.push(buy);
      } catch (err) {
        console.warn(
          `Ошибка проверки BUY ${
            buy.orderId.slice(0, 12)
          }...: ${(err as Error).message}`,
        );

        stillWaiting.push(buy);
      }
    }

    this.pendingBuys = stillWaiting;
  }

  /**
   * Проверяем SELL LIMIT 0.999.
   */
  private async checkPositions(): Promise<void> {
    const stillWatching: WatchedPosition[] = [];

    for (const pos of this.positions) {
      try {
        const order = await this.clob.getOrder(
          pos.orderId,
        );

        const matched = Number(
          (order as any)?.size_matched ?? 0,
        );

        /**
         * SELL полностью исполнен.
         */
        if (
          matched >= pos.filledSize - 0.0001 &&
          matched > 0
        ) {
          await this.closeAndNotify(
            pos,
            matched,
            EXIT_PRICE,
            "SELL LIMIT 0.999",
          );

          continue;
        }

        /**
         * Частичное исполнение SELL.
         */
        if (matched > 0) {
          console.log(
            `⏳ SELL частично исполнен: ${pos.city} / ${pos.binLabel} — ${matched.toFixed(4)} / ${pos.filledSize.toFixed(4)}`,
          );
        }

        /**
         * ВАЖНО:
         *
         * Здесь НЕТ продажи по рынку.
         *
         * Если SELL LIMIT не исполнился —
         * он продолжает висеть.
         */
        stillWatching.push(pos);
      } catch (err) {
        console.warn(
          `Ошибка проверки SELL ${
            pos.orderId.slice(0, 12)
          }...: ${(err as Error).message}`,
        );

        stillWatching.push(pos);
      }
    }

    this.positions = stillWatching;
  }

  /**
   * Единственное место, где отправляем Telegram.
   *
   * Только после фактического исполнения SELL.
   */
  private async closeAndNotify(
    pos: WatchedPosition,
    soldSize: number,
    exitPrice: number,
    how: string,
  ): Promise<void> {
    const profit =
      soldSize * (exitPrice - pos.buyPrice);

    const profitPct =
      ((exitPrice - pos.buyPrice) /
        pos.buyPrice) *
      100;

    const sign =
      profit >= 0 ? "✅" : "🔻";

    const msg =
      `${sign} <b>Сделка закрыта</b> (${how})\n` +
      `${pos.city} / ${pos.binLabel}\n` +
      `Вход: ${pos.buyPrice.toFixed(4)} → Выход: ${exitPrice.toFixed(4)}\n` +
      `Объём: ${soldSize.toFixed(4)} акций\n` +
      `Профит: ${
        profit >= 0 ? "+" : ""
      }$${profit.toFixed(3)} (${
        profitPct >= 0 ? "+" : ""
      }${profitPct.toFixed(2)}%)`;

    console.log(
      `\n${msg.replace(/<\/?b>/g, "")}\n`,
    );

    /**
     * РОВНО ОДНО Telegram-сообщение.
     */
    await this.telegram?.send(msg);
  }
}

async function handleCrossing(
  tokenId: string,
  info: TokenInfo,
  clob: ClobService | null,
  tracker: PositionTracker | null,
): Promise<void> {
  console.log(
    `\n=== ${info.city} / ${info.binLabel}: NO достиг ${ENTRY_PRICE} ===`,
  );

  if (DRY_RUN || !clob) {
    console.log(
      "[DRY_RUN] Реальный BUY LIMIT не отправлен.",
    );
    return;
  }

  try {
    /**
     * ВАЖНО:
     *
     * TRADE_SIZE_USD = сколько долларов хотим потратить.
     *
     * GTC BUY size = количество акций.
     *
     * Поэтому:
     *
     * $5 / 0.995 = ~5.025 акций.
     */
    const requestedShares =
      TRADE_SIZE_USD / ENTRY_PRICE;

    console.log(
      `📌 Выставляем BUY LIMIT: ${requestedShares.toFixed(4)} акций по ${ENTRY_PRICE}`,
    );

    const buyResp =
      await clob.placeGtcLimitOrder({
        tokenId,
        side: Side.BUY,

        /**
         * НИКАКОЙ покупки по bestAsk.
         * Строго наша лимитная цена.
         */
        price: ENTRY_PRICE,

        size: requestedShares,

        /**
         * 0 = цена не двигается.
         */
        offsetPct: 0,
      });

    console.log(
      "✅ BUY LIMIT выставлен:",
      buyResp,
    );

    if (!buyResp.orderId) {
      console.error(
        "❌ CLOB не вернул orderId BUY.",
      );
      return;
    }

    /**
     * Если BUY сразу исполнился,
     * всё равно добавляем его в tracker —
     * tracker увидит исполнение и выставит SELL.
     */
    tracker?.watchBuy({
      orderId: buyResp.orderId,
      tokenId,
      city: info.city,
      binLabel: info.binLabel,
      requestedShares,
      startedAt: Date.now(),
    });
  } catch (err) {
    console.error(
      `❌ Ошибка выставления BUY LIMIT: ${
        (err as Error).message
      }`,
    );
  }
}

async function main(): Promise<void> {
  console.log(
    `Режим: ${
      DRY_RUN
        ? "DRY_RUN (без реальных сделок)"
        : "⚠️ LIVE — РЕАЛЬНЫЕ ДЕНЬГИ"
    }`,
  );

  console.log(
    `NO достиг ${ENTRY_PRICE} → BUY LIMIT ${ENTRY_PRICE} → SELL LIMIT ${EXIT_PRICE}`,
  );

  console.log(
    `Размер сделки: $${TRADE_SIZE_USD}`,
  );

  console.log(
    `Telegram: только после полного закрытия SELL`,
  );

  console.log(
    `🚫 Market/FAK ордера отключены.`,
  );

  const logger: Logger =
    createLogger(false);

  const telegram =
    createTelegramNotifier(
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.TELEGRAM_CHAT_ID,
      logger,
    );

  if (telegram) {
    console.log(
      "Telegram настроен.",
    );
  }

  console.log(
    "Загружаем список рынков (только highest, только сегодня)...",
  );

  const markets =
    await discoverWeatherMarkets();

  const tokenIndex =
    buildTokenIndex(markets);

  const noTokenIds =
    [...tokenIndex.keys()];

  console.log(
    `Мониторим ${markets.length} рынков, ${noTokenIds.length} NO-токенов`,
  );

  console.log(
    "Города:",
    markets.map((m) => m.city).join(", "),
  );

  let clob: ClobService | null = null;
  let tracker: PositionTracker | null = null;

  if (!DRY_RUN) {
    clob = await ClobService.init(
      {
        host:
          process.env.CLOB_HOST ??
          "https://clob.polymarket.com",

        rpcUrl:
          process.env.RPC_URL,

        chainId:
          Number(
            process.env.CHAIN_ID ?? "137",
          ),

        privateKey:
          process.env.PRIVATE_KEY!,

        signatureType:
          Number(
            process.env.SIGNATURE_TYPE ?? "1",
          ),

        funderAddress:
          process.env.FUNDER_ADDRESS,
      },
      logger,
    );

    console.log(
      "ClobService инициализирован для LIVE торговли.",
    );

    tracker =
      new PositionTracker(
        clob,
        telegram,
      );

    tracker.start();
  }

  /**
   * Чтобы один и тот же NO-токен не получил
   * несколько BUY LIMIT подряд.
   */
  const alreadyBought =
    new Set<string>();

  const watcher =
    new PriceWatcher(
      noTokenIds,
      async (
        update: PriceUpdate,
      ) => {
        const price =
          update.bestAsk;

        if (price === null) {
          return;
        }

        /**
         * Сигнал возникает,
         * когда bestAsk достиг ENTRY_PRICE.
         */
        if (
          price < ENTRY_PRICE
        ) {
          return;
        }

        if (
          alreadyBought.has(
            update.tokenId,
          )
        ) {
          return;
        }

        const info =
          tokenIndex.get(
            update.tokenId,
          );

        if (!info) {
          return;
        }

        alreadyBought.add(
          update.tokenId,
        );

        await handleCrossing(
          update.tokenId,
          info,
          clob,
          tracker,
        );
      },
    );

  watcher.start();

  console.log(
    "👀 Мониторинг запущен.",
  );
}

main().catch((err) => {
  console.error(
    "Фатальная ошибка:",
    err,
  );

  process.exit(1);
});
