import { Side } from "@polymarket/clob-client";
import { Config, CopyStrategy } from "./config.js";
import { ClobService } from "./clob.js";
import { DataApiClient } from "./dataApi.js";
import { Logger } from "./logger.js";
import { State, ensureDailyVolume, noteSeenTrade, recordTradeStat } from "./state.js";
import { TelegramNotifier } from "./telegram.js";
import { ActivityTrade, Position } from "./types.js";
import { formatUsd, isPositive, nowSec } from "./utils.js";

const shortAddr = (addr: string): string =>
  addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

/** Trims float noise: 0.8523974082073434 -> "0.8524", 0.9960000000000001 -> "0.996" */
const formatPrice = (price: number): string => String(parseFloat(price.toFixed(4)));

const truncate = (s: string, max = 70): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

type NotifyStatus = "copied" | "skipped" | "dryrun" | "error";

const STATUS_META: Record<NotifyStatus, { emoji: string; label: string }> = {
  copied: { emoji: "✅", label: "СКОПИРОВАНО" },
  skipped: { emoji: "⏭", label: "ПРОПУЩЕНО" },
  dryrun: { emoji: "🧪", label: "ТЕСТОВЫЙ РЕЖИМ" },
  error: { emoji: "❌", label: "ОШИБКА" },
};

/**
 * Error/skip reasons can come either from our own code (already Russian) or
 * verbatim from the Polymarket CLOB API (always English, e.g. "no orders
 * found to match with FAK order..."). This maps the known API/library
 * messages to Russian so notifications read as one language end to end.
 * Unrecognized messages fall through untranslated rather than being hidden,
 * so nothing gets lost for troubleshooting.
 */
const translateReason = (raw: string): string => {
  const patterns: [RegExp, string][] = [
    [/no orders found to match/i, "нет встречной ликвидности по этой цене — ордер отменён биржей"],
    [/not enough balance/i, "недостаточно USDC на балансе Polymarket"],
    [/allowance/i, "не выставлен allowance USDC (включается один раз в настройках Polymarket)"],
    [/below the market minimum/i, "размер ордера меньше минимального, разрешённого для этого рынка"],
    [/Invalid market order amount/i, "не удалось посчитать сумму ордера (некорректная цена или размер)"],
    [/Order not filled/i, "ордер не нашёл встречной ликвидности и не исполнился"],
    [/CLOB rejected the order/i, "биржа отклонила ордер"],
  ];
  for (const [re, ru] of patterns) {
    if (re.test(raw)) return ru;
  }
  return raw;
};

/**
 * Compact, scannable Telegram message: status + side up top (the thing you
 * actually need at a glance when many trades come in), market name, the
 * trader's numbers on one line, an optional reason, an optional line for
 * what WE did (only meaningfully different from the trader's numbers when
 * copied), and a short time — instead of one field per line.
 */
const formatNotification = (params: {
  trade: ActivityTrade;
  marketTitle: string | undefined;
  status: NotifyStatus;
  reason?: string;
  ourOrder?: string;
}): string => {
  const { trade, marketTitle, status, reason, ourOrder } = params;
  const { emoji, label } = STATUS_META[status];
  const outcome = trade.outcome ? ` (${trade.outcome})` : "";
  const market = truncate(
    `${marketTitle ?? trade.title ?? `токен ${trade.asset.slice(0, 10)}…`}${outcome}`,
  );
  const when = new Date(trade.timestamp * 1000).toISOString().slice(11, 16);

  const lines = [
    `${emoji} <b>${label}</b> · ${trade.side}`,
    market,
    `Трейдер: ${formatPrice(trade.price)} · ${trade.size} шт (~$${formatUsd(trade.usdcSize)}) · <code>${shortAddr(trade.proxyWallet)}</code>`,
  ];
  if (ourOrder) lines.push(`Твой ордер: ${ourOrder}`);
  if (reason) lines.push(`Причина: ${truncate(reason, 160)}`);
  lines.push(`${when} UTC`);
  return lines.join("\n");
};

class PositionCache {
  private lastFetch = 0;
  private positions: Position[] = [];

  constructor(
    private dataApi: DataApiClient,
    private profileAddress: string,
    private ttlMs: number,
    private logger: Logger
  ) {}

  async getPositions(force = false): Promise<Position[]> {
    const now = Date.now();
    if (!force && now - this.lastFetch < this.ttlMs) return this.positions;
    this.positions = await this.dataApi.getPositions(this.profileAddress);
    this.lastFetch = now;
    return this.positions;
  }

  async getPositionByToken(tokenId: string): Promise<Position | undefined> {
    const positions = await this.getPositions();
    return positions.find((p) => p.asset === tokenId);
  }
}

export class CopyTrader {
  private positionCache: PositionCache;

  constructor(
    private config: Config,
    private clob: ClobService,
    private dataApi: DataApiClient,
    private state: State,
    private logger: Logger,
    private notifier?: TelegramNotifier
  ) {
    this.positionCache = new PositionCache(dataApi, config.profileAddress, 30000, logger);
  }

  /**
   * Records the trade's outcome into stats (always) and fires a Telegram
   * notification (only if configured). `reasonCode` is a short, stable key
   * used to group reasons in the `/stats` summary — separate from the
   * human-readable `reason` text shown in the per-trade notification.
   */
  private notify(
    trade: ActivityTrade,
    status: NotifyStatus,
    opts?: { reason?: string; ourOrder?: string; reasonCode?: string },
  ): void {
    if (status === "skipped" || status === "error") {
      recordTradeStat(this.state, status, opts?.reasonCode ?? "другое");
    } else {
      recordTradeStat(this.state, status);
    }
    if (!this.notifier) return;
    void (async () => {
      const marketTitle = trade.title ?? (await this.dataApi.getMarketTitle(trade.asset));
      const text = formatNotification({
        trade,
        marketTitle,
        status,
        reason: opts?.reason,
        ourOrder: opts?.ourOrder,
      });
      await this.notifier!.send(text);
    })();
  }

  private tradeKey(trade: ActivityTrade): string {
    // Rounded to avoid the same real-world fill being treated as two
    // different trades when it's detected both via REST polling and the
    // on-chain listener (their price/size math can differ by float dust).
    const roundedPrice = trade.price.toFixed(6);
    const roundedSize = trade.size.toFixed(6);
    return `${trade.transactionHash}:${trade.asset}:${trade.side}:${roundedSize}:${roundedPrice}`;
  }

  private effectiveRatio(trader: string): number {
    return this.config.traderAllocations[trader] ?? this.config.copyRatio;
  }

  private computeSize(trade: ActivityTrade): { size: number; notional: number } | null {
    const price = trade.price;
    if (!isPositive(price)) return null;

    const ratio = this.effectiveRatio(trade.proxyWallet.toLowerCase());
    let size = 0;
    let notional = 0;

    switch (this.config.copyStrategy as CopyStrategy) {
      case "PERCENT_USD":
        notional = trade.usdcSize * ratio;
        size = notional / price;
        break;
      case "PERCENT_SHARES":
        size = trade.size * ratio;
        notional = size * price;
        break;
      case "FIXED_USD":
        notional = this.config.fixedUsd;
        size = notional / price;
        break;
      case "FIXED_SHARES":
        size = this.config.fixedShares;
        notional = size * price;
        break;
      default:
        return null;
    }

    if (!isPositive(size) || !isPositive(notional)) return null;
    return { size, notional };
  }

  private clampToLimits(
    side: Side,
    size: number,
    notional: number,
    price: number
  ): { size: number; notional: number } | null {
    if (notional < this.config.minTradeUsd) return null;

    if (notional > this.config.maxTradeUsd) {
      notional = this.config.maxTradeUsd;
      size = notional / price;
    }

    if (!isPositive(size) || !isPositive(notional)) return null;

    if (side === Side.BUY) {
      ensureDailyVolume(this.state);
      const remaining = this.config.maxDailyVolumeUsd - this.state.dailyVolume.spentUsd;
      if (remaining <= 0) return null;
      if (notional > remaining) {
        notional = remaining;
        size = notional / price;
        if (notional < this.config.minTradeUsd) return null;
      }
    }

    return { size, notional };
  }

  private async clampToPosition(side: Side, tokenId: string, size: number, notional: number, price: number) {
    if (side === Side.BUY) {
      const position = await this.positionCache.getPositionByToken(tokenId);
      const priceHint = position?.curPrice ?? position?.avgPrice ?? price;
      const currentValue = position ? priceHint * position.size : 0;
      const remaining = this.config.maxPositionSizeUsd - currentValue;
      if (remaining <= 0) return null;
      if (notional > remaining) {
        notional = remaining;
        size = notional / price;
        if (notional < this.config.minTradeUsd) return null;
      }
      return { size, notional };
    }

    const position = await this.positionCache.getPositionByToken(tokenId);
    if (!position || position.size <= 0) return null;
    if (size > position.size) {
      size = position.size;
      notional = size * price;
      if (notional < this.config.minTradeUsd) return null;
    }
    return { size, notional };
  }

  private shouldCopySide(trade: ActivityTrade): boolean {
    if (this.config.copySide === "BOTH") return true;
    return this.config.copySide === trade.side;
  }

  async handleTrade(trade: ActivityTrade): Promise<void> {
    if (!this.shouldCopySide(trade)) {
      this.notify(trade, "skipped", {
        reason: `сторона ${trade.side} не копируется (COPY_SIDE=${this.config.copySide})`,
        reasonCode: "фильтр по стороне (COPY_SIDE)",
      });
      return;
    }

    const tradeKey = this.tradeKey(trade);
    if (this.state.seenTrades[tradeKey]) return;

    // Mark as seen IMMEDIATELY (synchronously, before any `await`) so that if
    // the REST poller and the on-chain listener both detect this same fill
    // at nearly the same time, the second one to arrive sees it as already
    // handled instead of racing past this check and placing a duplicate order.
    noteSeenTrade(this.state, tradeKey, trade.timestamp);

    const computed = this.computeSize(trade);
    if (!computed) {
      this.notify(trade, "skipped", {
        reason: `не удалось рассчитать размер ордера (некорректная цена или стратегия ${this.config.copyStrategy})`,
        reasonCode: "не удалось рассчитать размер ордера",
      });
      return;
    }

    const side = trade.side === "BUY" ? Side.BUY : Side.SELL;
    let size = computed.size;
    let notional = computed.notional;

    const clamped = this.clampToLimits(side, size, notional, trade.price);
    if (!clamped) {
      this.notify(trade, "skipped", {
        reason: "не прошла по лимитам (MIN_TRADE_USD/MAX_TRADE_USD/дневной лимит MAX_DAILY_VOLUME_USD)",
        reasonCode: "не прошло по лимитам сделки/дня",
      });
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }
    size = clamped.size;
    notional = clamped.notional;

    const positionClamped = await this.clampToPosition(side, trade.asset, size, notional, trade.price);
    if (!positionClamped) {
      this.notify(trade, "skipped", {
        reason: "лимит по позиции исчерпан (MAX_POSITION_SIZE_USD) или нечего продавать",
        reasonCode: "лимит по позиции исчерпан / нечего продавать",
      });
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }
    size = positionClamped.size;
    notional = positionClamped.notional;

    if (this.config.dryRun) {
      this.logger.info("DRY_RUN order", {
        side: trade.side,
        tokenId: trade.asset,
        price: trade.price,
        size,
        notional: formatUsd(notional),
      });
      this.notify(trade, "dryrun", {
        ourOrder: `${size.toFixed(4)} шт (~$${formatUsd(notional)}) — не отправлено (включён тестовый режим)`,
      });
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
      return;
    }

    try {
      const orderMode = this.config.orderMode;
      const fill =
        orderMode === "LIMIT"
          ? await this.clob.placeGtcLimitOrder({
              tokenId: trade.asset,
              side,
              price: trade.price,
              size,
              offsetPct: this.config.limitOffsetPct,
            })
          : await this.clob.placeLimitOrder({
              tokenId: trade.asset,
              side,
              price: trade.price,
              size,
              maxSlippagePct: this.config.maxSlippagePct,
            });
      if (side === Side.BUY) {
        ensureDailyVolume(this.state);
        this.state.dailyVolume.spentUsd += notional;
      }
      this.logger.info("Order placed", {
        mode: orderMode,
        side: trade.side,
        tokenId: trade.asset,
        price: trade.price,
        size,
        notional: formatUsd(notional),
        fill,
      });
      const ourOrderLabel =
        orderMode === "LIMIT"
          ? `${size.toFixed(4)} шт (~$${formatUsd(notional)}) лимиткой, статус: ${fill.status}`
          : `${size.toFixed(4)} шт (~$${formatUsd(notional)}) по ${formatPrice(trade.price)}`;
      this.notify(trade, "copied", {
        ourOrder: ourOrderLabel,
      });
    } catch (err) {
      const message = (err as Error).message ?? "unknown error";
      if (message.includes("not enough balance") || message.includes("allowance")) {
        this.logger.error("Order rejected: insufficient USDC balance or allowance.", {
          profile: this.config.profileAddress,
          hint: "Deposit USDC to your Polymarket account and ensure allowance is set in the Polymarket UI.",
        });
      }
      this.logger.warn("Order failed", { error: message });
      const translated = translateReason(message);
      this.notify(trade, "error", {
        reason: translated,
        // Group by the translated reason itself (it's already a short,
        // stable category for known errors); unrecognized messages fall
        // back to a generic bucket so /stats doesn't fill up with one-off
        // raw error strings.
        reasonCode: translated === message ? "прочая ошибка ордера" : translated,
      });
    } finally {
      noteSeenTrade(this.state, tradeKey, trade.timestamp);
    }
  }

  async runOnce(): Promise<void> {
  const now = nowSec();

  await Promise.all(
    this.config.copyTraders.map(async (trader) => {
      this.logger.debug("Polling trader", { trader });

      const last = this.state.lastSeen[trader];
      const start = last
        ? last + 1
        : now - this.config.tradeLookbackSec;

      let trades: ActivityTrade[] = [];

      try {
        trades = await this.dataApi.getTrades(
          trader,
          start,
          now,
          100,
        );
      } catch (err) {
        this.logger.warn("Failed to fetch trades", {
          trader,
          error: (err as Error).message,
        });
        return;
      }

      if (trades.length === 0) {
        this.logger.debug("No trades found", {
          trader,
          start,
          end: now,
        });
        return;
      }

      this.logger.info("Trades detected", {
        trader,
        count: trades.length,
      });

            for (const trade of trades) {
        await this.handleTrade(trade);

        this.state.lastSeen[trader] = Math.max(
          this.state.lastSeen[trader] || 0,
          trade.timestamp,
        );
      }
    }),
  );
  }
}
