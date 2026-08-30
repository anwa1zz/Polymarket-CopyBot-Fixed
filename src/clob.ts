import {
  ApiKeyCreds,
  Chain,
  ClobClient,
  OrderType,
  Side,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Logger } from "./logger.js";

export interface ClobConfig {
  host: string;
  rpcUrl?: string;
  chainId: number;
  privateKey: string;
  signatureType: number;
  funderAddress?: string;
  apiCreds?: ApiKeyCreds;
}

export interface MarketMeta {
  tickSize: string;
  minOrderSize: number;
  negRisk: boolean;
}

export class ClobService {
  private client: ClobClient;
  private logger: Logger;
  private metaCache = new Map<string, { meta: MarketMeta; ts: number }>();

  private constructor(client: ClobClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  static async init(
    config: ClobConfig,
    logger: Logger,
  ): Promise<ClobService> {
    const account = privateKeyToAccount(
      config.privateKey as `0x${string}`,
    );

    const walletClient = createWalletClient({
      account,
      transport: http(config.rpcUrl),
    });

    const chain =
      config.chainId === 137 ? Chain.POLYGON : Chain.AMOY;

    let creds = config.apiCreds;

    if (!creds) {
      logger.info("Deriving Polymarket V2 API keys");

      const tempClient = new ClobClient({
        host: config.host,
        chain,
        signer: walletClient,
      });

      creds = await tempClient.createOrDeriveApiKey();

      if (!creds?.key || !creds?.secret || !creds?.passphrase) {
        throw new Error("Unable to create/derive V2 API credentials");
      }

      logger.info("Derived Polymarket V2 API keys.");
    }

    const client = new ClobClient({
      host: config.host,
      chain,
      signer: walletClient,
      creds,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
    });

    return new ClobService(client, logger);
  }

  async getMarketMeta(tokenId: string): Promise<MarketMeta> {
    const cached = this.metaCache.get(tokenId);
    const now = Date.now();

    if (cached && now - cached.ts < 5 * 60 * 1000) {
      return cached.meta;
    }

    const ob = await this.client.getOrderBook(tokenId);

    const meta: MarketMeta = {
      tickSize: String(ob.tick_size),
      minOrderSize: Number(ob.min_order_size),
      negRisk: Boolean(ob.neg_risk),
    };

    this.metaCache.set(tokenId, {
      meta,
      ts: now,
    });

    return meta;
  }

  /**
   * Fetches the LIVE order book right now (never cached — unlike tick
   * size / min order size / negRisk, the best ask/bid change constantly,
   * so this always hits the CLOB fresh) and returns the current best
   * available price on each side.
   *
   * This is the key fix for chasing a fast-moving book: the trader's own
   * execution price can already be stale by the time we act (they may
   * have swept several price levels in one transaction), so pricing our
   * own order off of THEIR price can miss the book entirely. Pricing off
   * the live top-of-book instead means we're always aiming at whatever is
   * actually available right now.
   */
  private async getTopOfBook(tokenId: string): Promise<{
    bestAsk: number | null;
    bestBid: number | null;
    tickSize: string;
    minOrderSize: number;
    negRisk: boolean;
  }> {
    const ob = await this.client.getOrderBook(tokenId);

    const asks = (ob.asks ?? [])
      .map((o) => Number(o.price))
      .filter((p) => Number.isFinite(p));
    const bids = (ob.bids ?? [])
      .map((o) => Number(o.price))
      .filter((p) => Number.isFinite(p));

    const bestAsk = asks.length ? Math.min(...asks) : null;
    const bestBid = bids.length ? Math.max(...bids) : null;

    const meta: MarketMeta = {
      tickSize: String(ob.tick_size),
      minOrderSize: Number(ob.min_order_size),
      negRisk: Boolean(ob.neg_risk),
    };
    // This fetch already has fresh meta for free — keep the cache warm so
    // other callers don't pay for a redundant round trip.
    this.metaCache.set(tokenId, { meta, ts: Date.now() });

    return { bestAsk, bestBid, ...meta };
  }

  private roundToTick(
    price: number,
    tickSize: string,
    side: Side,
  ): number {
    const tick = Number(tickSize);

    if (!Number.isFinite(tick) || tick <= 0) {
      return price;
    }

    const factor = 1 / tick;
    const raw = price * factor;

    const rounded =
      side === Side.BUY
        ? Math.floor(raw)
        : Math.ceil(raw);

    return rounded / factor;
  }

  /**
   * "Chase the live book" FAK order — this is the main execution path.
   *
   * Instead of pricing off the trader's own execution price (which can
   * already be stale — they may have swept several price levels in one
   * transaction, so by the time we act, their price may no longer be
   * available at all), this fetches the order book FRESH right now and
   * prices directly off whatever is actually sitting there:
   *   BUY  -> current best ASK (+ a small buffer to also clear a level or
   *           two if the top of book is thin)
   *   SELL -> current best BID (- a small buffer, same reasoning)
   *
   * Two hard rules, exactly as requested:
   *   1. Get it filled — price off what's really available right now, not
   *      a number that might already be gone.
   *   2. Never pay above 0.999 (or sell below 0.001) no matter what.
   *
   * It's still a FAK (fill-and-kill) order: it fills as much as it can
   * immediately and kills the rest — nothing is left resting on the book,
   * so no funds get tied up waiting.
   */
  async placeLimitOrder(params: {
    tokenId: string;
    side: Side;
    price: number; // trader's execution price — used ONLY as a fallback if the live book is empty on that side
    size: number;
    maxSlippagePct?: number; // now used as the small buffer added past the live best ask/bid, default 0.5%
  }): Promise<{ status: string; filledSize?: string; filledUsdc?: string }> {
    const { tokenId, side, size } = params;

    const book = await this.getTopOfBook(tokenId);

    const liveRef =
      side === Side.BUY
        ? book.bestAsk ?? params.price
        : book.bestBid ?? params.price;

    const bufferPct = params.maxSlippagePct ?? 0.5;
    const rawCap =
      side === Side.BUY
        ? liveRef * (1 + bufferPct / 100)
        : liveRef * (1 - bufferPct / 100);

    // Hard ceiling/floor — Polymarket's actual valid price range. This is
    // the absolute rule: never above 0.999, never below 0.001, no matter
    // what the live book or buffer says.
    const cappedPrice = this.roundToTick(
      Math.min(0.999, Math.max(0.001, rawCap)),
      book.tickSize,
      side,
    );

    if (size < book.minOrderSize) {
      throw new Error(
        `Order size ${size} is below the market minimum ${book.minOrderSize} — not submitted.`
      );
    }

    /*
     * Market FAK order.
     *
     * BUY:
     *   amount = USDC to spend, budgeted off the LIVE reference price so
     *   it's sized to what things actually cost right now.
     *
     * SELL:
     *   amount = number of shares to sell (unchanged either way).
     */
    const amount =
      side === Side.BUY
        ? liveRef * size
        : size;

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid market order amount computed (${amount}) for tokenId=${tokenId}`);
    }

    const resp = await this.client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount,
        side,
        price: cappedPrice,
        orderType: OrderType.FAK,
      },
      {
        tickSize: book.tickSize as any,
        negRisk: book.negRisk,
      },
      OrderType.FAK,
    );

    this.logger.info("Market FAK order submitted (priced off live book)", {
      tokenId,
      side,
      amount,
      liveRef,
      cappedPrice,
      traderPrice: params.price,
      size,
      response: resp,
    });

    // The client can resolve with two different shapes depending on what
    // the CLOB returned:
    //  - a real OrderResponse: { success, status, orderID, makingAmount, ... }
    //  - a raw error body on rejection: { error, orderID, status } where
    //    `status` here is an HTTP status code (e.g. 400), not "matched" —
    //    e.g. "no orders found to match with FAK order" when there's no
    //    counter-liquidity to fill against.
    // Treat anything that isn't an explicit `success: true` + status
    // "matched" as a non-fill, using whichever error field is present.
    const respAny = resp as unknown as {
      success?: boolean;
      status?: string | number;
      error?: string;
      errorMsg?: string;
      makingAmount?: string;
      takingAmount?: string;
    };

    if (respAny.success !== true) {
      const reason = respAny.error || respAny.errorMsg || `CLOB rejected the order (status: ${respAny.status})`;
      throw new Error(reason);
    }
    if (respAny.status !== "matched") {
      throw new Error(
        `Order not filled — status "${respAny.status}" (no counter-liquidity for a FAK order; nothing was bought/sold)`
      );
    }

    return {
      status: String(respAny.status),
      filledSize: respAny.makingAmount,
      filledUsdc: respAny.takingAmount,
    };
  }

  /**
   * GTC (Good-Till-Cancelled) limit order — used when ORDER_MODE=LIMIT.
   *
   * Unlike the market FAK order above, this does NOT require immediate full
   * liquidity: if only part fills right away, the rest just sits on the book
   * as a resting order until it fills or is cancelled (no time limit here).
   *
   * The price is shifted away from the trader's original price by
   * `offsetPct` in the direction that makes the order MORE aggressive
   * (crosses further into the book), which is what makes it likely to fill
   * fast instead of sitting unfilled at the exact price the other trader got:
   *   BUY  -> price * (1 + offsetPct/100)  (willing to pay a bit more)
   *   SELL -> price * (1 - offsetPct/100)  (willing to accept a bit less)
   */
  async placeGtcLimitOrder(params: {
    tokenId: string;
    side: Side;
    price: number;
    size: number;
    offsetPct?: number;
  }): Promise<{ status: string; orderId?: string; filledSize?: string; filledUsdc?: string }> {
    const { tokenId, side, size } = params;

    const meta = await this.getMarketMeta(tokenId);

    const offsetPct = params.offsetPct ?? 2;
    const rawOffsetPrice =
      side === Side.BUY
        ? params.price * (1 + offsetPct / 100)
        : params.price * (1 - offsetPct / 100);

    // Keep inside Polymarket's valid price range (0.001–0.999) — see the
    // same note in placeLimitOrder() above.
    const boundedPrice = Math.min(0.999, Math.max(0.001, rawOffsetPrice));
    const price = this.roundToTick(boundedPrice, meta.tickSize, side);

    if (size < meta.minOrderSize) {
      throw new Error(
        `Order size ${size} is below the market minimum ${meta.minOrderSize} — not submitted.`
      );
    }

    const resp = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side,
      },
      {
        tickSize: meta.tickSize as any,
        negRisk: meta.negRisk,
      },
      OrderType.GTC,
    );

    this.logger.info("GTC limit order submitted", {
      tokenId,
      side,
      price,
      offsetPct,
      referencePrice: params.price,
      size,
      response: resp,
    });

    // Same response-shape handling as the market order above: a rejection
    // comes back as a raw error body rather than a thrown exception.
    const respAny = resp as unknown as {
      success?: boolean;
      status?: string | number;
      orderID?: string;
      error?: string;
      errorMsg?: string;
      makingAmount?: string;
      takingAmount?: string;
    };

    // Same rule as the market order above: `success: true` is the
    // authoritative signal that the CLOB accepted the order. Unlike the
    // market FAK order, a GTC order doesn't need to fill immediately to
    // count as accepted — it can also come back as "live" (resting on the
    // book, waiting to fill) rather than "matched" (filled right away), and
    // both are a success here. We don't gate on the exact status string
    // beyond that since the CLOB's full status vocabulary isn't part of the
    // SDK's public types — only `success` is documented/stable.
    if (respAny.success !== true) {
      const reason = respAny.error || respAny.errorMsg || `CLOB rejected the order (status: ${respAny.status})`;
      throw new Error(reason);
    }

    return {
      status: String(respAny.status ?? "accepted"),
      orderId: respAny.orderID,
      filledSize: respAny.makingAmount,
      filledUsdc: respAny.takingAmount,
    };
  }
  async getOrder(orderId: string) {
    return this.client.getOrder(orderId);
  }

  async cancelOrders(orderIds: string[]) {
    return this.client.cancelOrders(orderIds);
  }
}
