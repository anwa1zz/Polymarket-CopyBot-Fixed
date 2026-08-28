import { promises as fs } from "fs";
import path from "path";

export interface Stats {
  /** UTC ISO timestamp of when stats collection started (first bot start, or last reset). */
  since: string;
  totalSeen: number;
  copied: number;
  skipped: number;
  dryrun: number;
  errors: number;
  /** Short reason code -> count, for skipped trades. */
  skipReasons: Record<string, number>;
  /** Short reason code -> count, for failed/errored trades. */
  errorReasons: Record<string, number>;
}

export interface TradeLogEntry {
  /** UTC ISO timestamp of when this trade was processed. */
  ts: string;
  trader: string;
  side: "BUY" | "SELL";
  /** Market/outcome title, or a shortened token id if the title wasn't available. */
  market: string;
  traderPrice: number;
  traderSize: number;
  traderUsdc: number;
  status: "copied" | "skipped" | "dryrun" | "error";
  reason?: string;
  ourOrder?: string;
}

export interface State {
  lastSeen: Record<string, number>;
  seenTrades: Record<string, number>;
  dailyVolume: {
    day: string;
    spentUsd: number;
  };
  redeemAttempts: Record<string, number>;
  stats: Stats;
  /** Most recent trades, newest first — capped at MAX_TRADE_LOG entries. Powers the Telegram "логи" reply. */
  tradeLog: TradeLogEntry[];
  /** Telegram getUpdates offset, so we don't re-process old messages after a restart. */
  telegramUpdateOffset: number;
}

const defaultStats = (): Stats => ({
  since: new Date().toISOString(),
  totalSeen: 0,
  copied: 0,
  skipped: 0,
  dryrun: 0,
  errors: 0,
  skipReasons: {},
  errorReasons: {},
});

const defaultState = (): State => ({
  lastSeen: {},
  seenTrades: {},
  dailyVolume: {
    day: "",
    spentUsd: 0,
  },
  redeemAttempts: {},
  stats: defaultStats(),
  tradeLog: [],
  telegramUpdateOffset: 0,
});

const dayKeyUtc = (date = new Date()): string => {
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${date.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
};

export const loadState = async (filePath: string): Promise<State> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as State;
    return {
      ...defaultState(),
      ...parsed,
      lastSeen: parsed.lastSeen ?? {},
      seenTrades: parsed.seenTrades ?? {},
      dailyVolume: parsed.dailyVolume ?? { day: "", spentUsd: 0 },
      redeemAttempts: parsed.redeemAttempts ?? {},
      stats: parsed.stats ?? defaultStats(),
      tradeLog: parsed.tradeLog ?? [],
      telegramUpdateOffset: parsed.telegramUpdateOffset ?? 0,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
    throw err;
  }
};

export const saveState = async (filePath: string, state: State): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
};

export const ensureDailyVolume = (state: State, now = new Date()): void => {
  const key = dayKeyUtc(now);
  if (state.dailyVolume.day !== key) {
    state.dailyVolume.day = key;
    state.dailyVolume.spentUsd = 0;
  }
};

export const noteSeenTrade = (state: State, tradeKey: string, timestamp: number): void => {
  state.seenTrades[tradeKey] = timestamp;
};

export const pruneSeenTrades = (state: State, maxAgeSec: number): void => {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
  for (const [key, ts] of Object.entries(state.seenTrades)) {
    if (ts < cutoff) delete state.seenTrades[key];
  }
};

export const markRedeemAttempt = (state: State, conditionId: string): void => {
  state.redeemAttempts[conditionId] = Math.floor(Date.now() / 1000);
};

/**
 * Records one detected trade's outcome into the running stats. Called once
 * per trade regardless of whether Telegram notifications are configured, so
 * `/stats`-style summaries stay accurate even if notifications are off.
 */
export const recordTradeStat = (
  state: State,
  status: "copied" | "skipped" | "dryrun" | "error",
  reasonCode?: string,
): void => {
  const stats = state.stats;
  stats.totalSeen += 1;
  if (status === "copied") stats.copied += 1;
  else if (status === "dryrun") stats.dryrun += 1;
  else if (status === "skipped") {
    stats.skipped += 1;
    if (reasonCode) stats.skipReasons[reasonCode] = (stats.skipReasons[reasonCode] ?? 0) + 1;
  } else if (status === "error") {
    stats.errors += 1;
    if (reasonCode) stats.errorReasons[reasonCode] = (stats.errorReasons[reasonCode] ?? 0) + 1;
  }
};

export const resetStats = (state: State): void => {
  state.stats = defaultStats();
};

/** Keeps the trade log from growing forever — only the most recent trades matter for "логи". */
const MAX_TRADE_LOG = 40;

/**
 * Records one detected trade's full detail (market, prices, status, reason)
 * for the Telegram "логи" reply — separate from `recordTradeStat`'s
 * aggregate counters, this keeps the actual per-trade history so a specific
 * trade can be looked up without digging through Railway logs.
 */
export const recordTradeLogEntry = (state: State, entry: TradeLogEntry): void => {
  state.tradeLog.unshift(entry);
  if (state.tradeLog.length > MAX_TRADE_LOG) {
    state.tradeLog.length = MAX_TRADE_LOG;
  }
};
