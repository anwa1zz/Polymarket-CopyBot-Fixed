import { createPublicClient, webSocket, parseAbiItem, decodeEventLog, type Log, getAddress, type Address } from "viem";
import { polygon } from "viem/chains";
import { Logger } from "./logger.js";
import { ActivityTrade, TradeSide } from "./types.js";

// Confirmed live on Polygon mainnet from @polymarket/clob-client-v2's own
// getContractConfig(137), and cross-checked against a real trade's decoded
// logs on Polygonscan (Aug 2026, post CTF Exchange V2 migration).
export const EXCHANGE_ADDRESSES: Address[] = [
  getAddress("0xE111180000d2663C0091e4f400237545B87B996B"), // CTF Exchange V2
  getAddress("0xe2222d279d744050d28e00520010520000310F59"), // Neg Risk CTF Exchange V2
];

// Decoded straight from a real transaction's event logs (see conversation).
const ORDER_FILLED_EVENT = parseAbiItem(
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)",
);

const COLLATERAL_DECIMALS = 6;
const CONDITIONAL_DECIMALS = 6;

const toFloat = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

export interface OnchainListenerConfig {
  wssUrl: string;
  copyTraders: string[]; // lowercased addresses
  onTrade: (trade: ActivityTrade) => Promise<void>;
  logger: Logger;
}

export class OnchainListener {
  private client;
  private traderSet: Set<string>;
  private unwatchFns: Array<() => void> = [];

  constructor(private config: OnchainListenerConfig) {
    this.traderSet = new Set(config.copyTraders.map((t) => t.toLowerCase()));
    this.client = createPublicClient({
      chain: polygon,
      transport: webSocket(config.wssUrl, {
        reconnect: { attempts: Infinity, delay: 2000 },
        keepAlive: { interval: 15000 },
      }),
    });
  }

  private handleLog(log: Log) {
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: [ORDER_FILLED_EVENT],
        data: log.data,
        topics: log.topics,
      });
    } catch (err) {
      this.config.logger.warn("Failed to decode OrderFilled log", {
        error: (err as Error).message,
      });
      return;
    }

    const { maker, taker, side, tokenId, makerAmountFilled, takerAmountFilled, fee } =
      decoded.args as {
        maker: Address;
        taker: Address;
        side: number;
        tokenId: bigint;
        makerAmountFilled: bigint;
        takerAmountFilled: bigint;
        fee: bigint;
      };

    const makerLower = maker.toLowerCase();
    const takerLower = taker.toLowerCase();

    // A copied trader may appear as maker OR taker on any given fill.
    // If they're the maker, their side is the event's `side` field directly.
    // If they're the taker, their side is the OPPOSITE (they're on the other
    // leg of the same fill).
    const roles: Array<{ trader: string; effectiveSide: TradeSide }> = [];

    if (this.traderSet.has(makerLower)) {
      roles.push({
        trader: makerLower,
        effectiveSide: side === 0 ? "BUY" : "SELL",
      });
    }
    if (this.traderSet.has(takerLower)) {
      roles.push({
        trader: takerLower,
        effectiveSide: side === 0 ? "SELL" : "BUY",
      });
    }

    if (roles.length === 0) return; // Not one of our copied traders.

    const sharesRaw = side === 0 ? takerAmountFilled : makerAmountFilled;
    const collateralRaw = side === 0 ? makerAmountFilled : takerAmountFilled;

    const shares = toFloat(sharesRaw, CONDITIONAL_DECIMALS);
    const usdcSize = toFloat(collateralRaw, COLLATERAL_DECIMALS);
    const price = shares > 0 ? usdcSize / shares : 0;

    for (const { trader, effectiveSide } of roles) {
      const trade: ActivityTrade = {
        proxyWallet: trader,
        timestamp: Math.floor(Date.now() / 1000),
        conditionId: "",
        type: "TRADE",
        size: shares,
        usdcSize,
        transactionHash: log.transactionHash ?? "",
        price,
        asset: tokenId.toString(),
        side: effectiveSide,
        outcomeIndex: 0,
      };

      this.config.logger.info("On-chain fill detected", {
        trader,
        side: effectiveSide,
        tokenId: trade.asset,
        price,
        shares,
        usdcSize,
        fee: toFloat(fee, COLLATERAL_DECIMALS),
        tx: trade.transactionHash,
      });

      // Fire and forget per-trade; errors are logged inside onTrade's own
      // try/catch (copyTrader.handleTrade already swallows/logs its errors).
      void this.config.onTrade(trade).catch((err) => {
        this.config.logger.error("onTrade handler failed", {
          error: (err as Error).message,
        });
      });
    }
  }

  start(): void {
    for (const address of EXCHANGE_ADDRESSES) {
      // Subscribe filtering on `maker` (topic position 2).
      const unwatchMaker = this.client.watchEvent({
        address,
        event: ORDER_FILLED_EVENT,
        args: { maker: [...this.traderSet].map((t) => getAddress(t)) as Address[] },
        onLogs: (logs) => logs.forEach((l) => this.handleLog(l)),
        onError: (err) =>
          this.config.logger.error("watchEvent(maker) error", { address, error: err.message }),
      });

      // Subscribe filtering on `taker` (topic position 3).
      const unwatchTaker = this.client.watchEvent({
        address,
        event: ORDER_FILLED_EVENT,
        args: { taker: [...this.traderSet].map((t) => getAddress(t)) as Address[] },
        onLogs: (logs) => logs.forEach((l) => this.handleLog(l)),
        onError: (err) =>
          this.config.logger.error("watchEvent(taker) error", { address, error: err.message }),
      });

      this.unwatchFns.push(unwatchMaker, unwatchTaker);
    }

    this.config.logger.info("On-chain listener started", {
      exchanges: EXCHANGE_ADDRESSES,
      traders: [...this.traderSet],
    });
  }

  stop(): void {
    this.unwatchFns.forEach((fn) => fn());
    this.unwatchFns = [];
  }
}
