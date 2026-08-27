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
  }): Promise<void> {
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
    const slippagePct = params.maxSlippagePct ?? 3;
    const worstPrice =
      side === Side.BUY
        ? price * (1 + slippagePct / 100)
        : price * (1 - slippagePct / 100);

    const cappedWorstPrice = this.roundToTick(
      Math.min(0.99, Math.max(0.01, worstPrice)),
      meta.tickSize,
      side,
    );

    const size = params.size;

    if (size < meta.minOrderSize) {
      this.logger.warn("Order size below minimum", {
        tokenId,
        size,
        min: meta.minOrderSize,
      });

      return;
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
      this.logger.warn("Invalid market order amount", {
        tokenId,
        side,
        amount,
        price,
        size,
      });

      return;
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
  }
}
