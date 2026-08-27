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

    async placeLimitOrder(params: {
    tokenId: string;
    side: Side;
    price: number;
    size: number;
    maxSlippagePct?: number;
  }): Promise<{ status: string; filledSize?: string; filledUsdc?: string }> {
    const { tokenId, side } = params;

    const meta = await this.getMarketMeta(tokenId);

    const price = this.roundToTick(
      params.price,
      meta.tickSize,
      side,
    );

    // Worst acceptable execution price. Without this, createAndPostMarketOrder
    // sweeps the book with NO price cap at all — it will fill at any price
    // available until the requested USDC amount is exhausted. This is what
    // caused fills far above the reference price (e.g. 95c instead of 54c).
    //
    // The safety bound itself must stay inside Polymarket's actual valid
    // price range (0.001–0.999) rather than an arbitrary round number —
    // markets close to resolution routinely trade at 0.99+ / 0.01-, and a
    // hard 0.99 ceiling would silently block copying those trades no
    // matter how high MAX_SLIPPAGE_PCT is set.
    const slippagePct = params.maxSlippagePct ?? 3;
    const worstPrice =
      side === Side.BUY
        ? price * (1 + slippagePct / 100)
        : price * (1 - slippagePct / 100);

    const cappedWorstPrice = this.roundToTick(
      Math.min(0.999, Math.max(0.001, worstPrice)),
      meta.tickSize,
      side,
    );

    const size = params.size;

    if (size < meta.minOrderSize) {
      throw new Error(
        `Order size ${size} is below the market minimum ${meta.minOrderSize} — not submitted.`
      );
    }

    /*
     * Market FAK order.
     *
     * BUY:
     *   amount = USDC to spend.
     *
     * SELL:
     *   amount = number of shares to sell.
     *
     * The existing CopyTrader passes `size` as shares,
     * so for BUY we convert shares -> approximate USDC
     * using the observed execution price.
     */
    const amount =
      side === Side.BUY
        ? price * size
        : size;

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid market order amount computed (${amount}) for tokenId=${tokenId}`);
    }

    const resp = await this.client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount,
        side,
        price: cappedWorstPrice,
        orderType: OrderType.FAK,
      },
      {
        tickSize: meta.tickSize as any,
        negRisk: meta.negRisk,
      },
      OrderType.FAK,
    );

    this.logger.info("Market FAK order submitted", {
      tokenId,
      side,
      amount,
      price,
      worstPrice: cappedWorstPrice,
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
}
