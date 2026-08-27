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
  const when =
