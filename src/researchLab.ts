/**
 * LAB — новый исследовательский парсер (НЕ торгует, только собирает статистику).
 * Работает отдельным процессом, свой файл состояния (research-lab-state.json),
 * свои команды в Telegram (все начинаются со слова "лаб").
 *
 * Что собирает (все входы считаются КАК В БОТЕ: цена входа = лучший ask,
 * итог определяется только официальным резолвом Gamma API, держим до резолва):
 *
 *  1. «Запас» вместо порога — один параметр z на все монеты:
 *     z = движение монеты в сторону токена / (типичное 5-мин движение × √(осталось/300)).
 *     Цена токена 0.97-0.98, как в боте.
 *  2. «Недооценка» — монета уже прошла порог в нужную сторону, а токен стоит 0.85-0.96.
 *  3. «Паника без разворота» — токен был ≥0.97, просел до 0.85-0.95, монета всё ещё за порогом.
 *  4. «Импульс последних секунд» — монета резко прошла N% за последние 15/30с в сторону токена.
 *  5. «Арбитраж Up+Down» — как часто сумма лучших ask обеих сторон ≤ 0.99 / 0.98 / 0.97 / 0.95.
 *  6. «Подтверждение другими монетами» — к каждому входу пишется, сколько ДРУГИХ монет
 *     в этот момент идут в ту же сторону (порог 0.05% и 0.10% от открытия окна).
 *  7. «Согласие профилей» — внутри парсера моделируются 5 профилей бота (настройки ниже,
 *     BOT_PROFILES). Смотрим, как меняется винрейт, когда сигнал дали сразу несколько профилей.
 *
 * ВАЖНО: если меняешь настройки профилей в боте — поменяй их и в BOT_PROFILES ниже.
 *
 * Переменные окружения: LAB_TELEGRAM_BOT_TOKEN и LAB_TELEGRAM_CHAT_ID
 * (если не заданы — берутся TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID).
 * Для нового Railway-сервиса лучше завести ОТДЕЛЬНОГО Telegram-бота (через @BotFather),
 * иначе два процесса с одним токеном будут «воровать» друг у друга команды.
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { discoverCryptoUpDownMarkets, CryptoUpDownMarket } from "./cryptoMarketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { btcPriceFeed } from "./btcPriceFeed.js";
import { ethPriceFeed } from "./ethPriceFeed.js";
import { solPriceFeed } from "./solPriceFeed.js";
import { xrpPriceFeed } from "./xrpPriceFeed.js";
import { dogePriceFeed } from "./dogePriceFeed.js";
import { VolatilityTracker } from "./volatilityTracker.js";
import { createTelegramNotifier } from "./telegram.js";
import { createLogger } from "./logger.js";

// ─────────────────────────── Общие настройки ───────────────────────────

const STATE_FILE = path.resolve(process.cwd(), "research-lab-state.json");
const AUTOSAVE_INTERVAL_MS = 60 * 1000;

const TARGET_WINDOW_MINUTES = 5;
const TIMEFRAMES_TO_DISCOVER = [{ suffixes: ["up-or-down-5m"], minutes: TARGET_WINDOW_MINUTES }];

const MARKET_REFRESH_MS = 30 * 1000;
const RESOLVE_CHECK_DELAY_SEC = 180;
const RESOLVE_GIVE_UP_MS = 60 * 60 * 1000;
const GAMMA_HOST = "https://gamma-api.polymarket.com";

const MIN_TRADES_FOR_TOP = 10; // минимум записей, чтобы комбинация попала в топ
const MAX_SETTLED_REMEMBERED = 3000;

interface CoinPriceFeed {
  getPriceAt(ts: number): number | null;
  getLatestPrice(): number | null;
}
const PRICE_FEEDS: Record<string, CoinPriceFeed> = {
  Bitcoin: btcPriceFeed,
  Ethereum: ethPriceFeed,
  Solana: solPriceFeed,
  XRP: xrpPriceFeed,
  Dogecoin: dogePriceFeed,
};
const INCLUDED_COINS = Object.keys(PRICE_FEEDS);
const COIN_SHORT: Record<string, string> = {
  Bitcoin: "BTC",
  Ethereum: "ETH",
  Solana: "SOL",
  XRP: "XRP",
  Dogecoin: "DOGE",
};

const volTracker = new VolatilityTracker(PRICE_FEEDS);

// ─────────────────────────── Сетки идей ───────────────────────────

// 1. «Запас»
const Z_LEVELS = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0];
const MARGIN_WINDOWS = [30, 60, 90, 120, 180, 300];
const MARGIN_PRICE_LOW = 0.97;
const MARGIN_PRICE_HIGH = 0.98;

// 2. «Недооценка»
const CHEAP_THRESHOLDS = [0.001, 0.0015, 0.002, 0.003];
const CHEAP_WINDOWS = [60, 90, 120, 180, 300];
const CHEAP_BANDS: [number, number][] = [
  [0.85, 0.9],
  [0.9, 0.93],
  [0.93, 0.96],
];

// 3. «Паника без разворота»
const PANIC_THRESHOLDS = [0.001, 0.0015, 0.002, 0.003];
const PANIC_WINDOWS = [30, 60, 90, 120, 180, 300];
const PANIC_BANDS: [number, number][] = [
  [0.85, 0.9],
  [0.9, 0.95],
];
const PANIC_PEAK = 0.97;

// 4. «Импульс последних секунд»
const IMPULSE_LOOKBACKS_SEC = [15, 30];
const IMPULSE_THRESHOLDS = [0.0003, 0.0005, 0.0008, 0.0012];
const IMPULSE_WINDOWS = [60, 120, 180];
const IMPULSE_ASK_MIN = 0.6;
const IMPULSE_ASK_MAX = 0.98;

// 5. «Арбитраж»
const ARB_THRESHOLDS = [0.99, 0.98, 0.97, 0.95];

// 6. «Подтверждение другими монетами»
const CONFIRM_LEVEL_1 = 0.0005; // 0.05%
const CONFIRM_LEVEL_2 = 0.001; // 0.10%

// ─────────────────────────── Профили бота (моделирование) ───────────────────────────

interface BotProfile {
  id: number;
  mode: "fixed" | "adaptive";
  priceMode: "corridor" | "touch-drop" | "none" | "retouch";
  priceLow?: number;
  priceHigh?: number;
  touchAbove?: number;
  retouchDropBelow?: number;
  windowSec: Record<string, number>;
  param: Record<string, number>; // fixed: доля (0.0015 = 0.15%), adaptive: множитель
}

const DEFAULT_LOW = 0.97;
const DEFAULT_HIGH = 0.98;

const BOT_PROFILES: BotProfile[] = [
  {
    id: 1,
    mode: "fixed",
    priceMode: "corridor",
    windowSec: { Bitcoin: 180, Ethereum: 180, Solana: 120, XRP: 180, Dogecoin: 90 },
    param: { Bitcoin: 0.0015, Ethereum: 0.002, Solana: 0.002, XRP: 0.003, Dogecoin: 0.0015 },
  },
  {
    id: 2,
    mode: "adaptive",
    priceMode: "corridor",
    windowSec: { Bitcoin: 120, Ethereum: 120, Solana: 60, XRP: 30, Dogecoin: 60 },
    param: { Bitcoin: 1.5, Ethereum: 1.5, Solana: 0.7, XRP: 0.3, Dogecoin: 0.5 },
  },
  {
    id: 3,
    mode: "fixed",
    priceMode: "touch-drop",
    touchAbove: 0.995,
    priceLow: 0.985,
    priceHigh: 0.993,
    windowSec: { Bitcoin: 180, Ethereum: 180, Solana: 90, XRP: 180, Dogecoin: 90 },
    param: { Bitcoin: 0.0013, Ethereum: 0.0014, Solana: 0.0015, XRP: 0.0015, Dogecoin: 0.0015 },
  },
  {
    id: 4,
    mode: "fixed",
    priceMode: "none",
    windowSec: { Bitcoin: 10, Ethereum: 10, Solana: 10, XRP: 30, Dogecoin: 60 },
    param: { Bitcoin: 0.002, Ethereum: 0.001, Solana: 0.001, XRP: 0.0014, Dogecoin: 0.003 },
  },
  {
    id: 5,
    mode: "fixed",
    priceMode: "retouch",
    priceLow: 0.97,
    priceHigh: 0.98,
    retouchDropBelow: 0.9,
    windowSec: { Bitcoin: 180, Ethereum: 180, Solana: 180, XRP: 180, Dogecoin: 120 },
    param: { Bitcoin: 0.001, Ethereum: 0.0013, Solana: 0.002, XRP: 0.001, Dogecoin: 0.001 },
  },
];

// ─────────────────────────── Типы и хелперы ───────────────────────────

interface Stat {
  w: number;
  t: number;
  roi: number; // сумма доходностей на $1 ставки
}
type StatMap = Record<string, Stat>;

function bump(m: StatMap, key: string, won: boolean, roi: number): void {
  const s = m[key] ?? (m[key] = { w: 0, t: 0, roi: 0 });
  s.t++;
  if (won) s.w++;
  s.roi += roi;
}

interface LabEntry {
  idea: string; // "margin" | "cheap" | "panic" | "impulse" | "bot1".."bot5"
  combo: string;
  coin: string;
  side: "Up" | "Down";
  ts: number;
  price: number; // цена входа = ask
  sec: number; // секунд до закрытия в момент входа
  c05: number; // сколько других монет идут в ту же сторону >= 0.05%
  c10: number; // то же для >= 0.10%
}

interface ArbMarketInfo {
  minSum: number;
  sec99: number | null;
}

interface PendingMarket {
  closeTimeMs: number;
  coin: string;
  entries: LabEntry[];
  arb: ArbMarketInfo | null;
}

interface ArbAgg {
  total: number;
  minSumTotal: number;
  h99: number;
  h98: number;
  h97: number;
  h95: number;
  sec99Sum: number;
}

interface TokenInfo {
  market: CryptoUpDownMarket;
  side: "Up" | "Down";
}

interface Quote {
  bid: number | null;
  ask: number | null;
}

function buildTokenIndex(markets: CryptoUpDownMarket[]): Map<string, TokenInfo> {
  const idx = new Map<string, TokenInfo>();
  for (const m of markets) {
    idx.set(m.upTokenId, { market: m, side: "Up" });
    idx.set(m.downTokenId, { market: m, side: "Down" });
  }
  return idx;
}

function isIncludedCoin(coin: string): boolean {
  return INCLUDED_COINS.some((c) => c.toUpperCase() === coin.toUpperCase());
}

function observeWindowMs(windowMinutes: number): number {
  return (windowMinutes + 1) * 60 * 1000;
}

function pctLabel(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function winPct(w: number, t: number): string {
  if (t <= 0) return "—";
  if (w === t) return "100%";
  const r = (100 * w) / t;
  return r >= 99.5 ? `${r.toFixed(1)}%` : `${r.toFixed(0)}%`;
}

function roiLabel(roiSum: number, t: number): string {
  if (t <= 0) return "—";
  const r = (roiSum / t) * 100;
  return `${r >= 0 ? "+" : ""}${r.toFixed(1)}%`;
}

function findBand(bands: [number, number][], price: number): [number, number] | null {
  for (const b of bands) {
    if (price >= b[0] && price < b[1]) return b;
  }
  return null;
}

async function resolveWinner(eventSlug: string): Promise<"Up" | "Down" | null> {
  try {
    const resp = await fetch(`${GAMMA_HOST}/events/slug/${eventSlug}`);
    if (!resp.ok) return null;
    const event = await resp.json();
    const market = (event.markets ?? [])[0];
    if (!market) return null;

    let outcomes: string[];
    let outcomePrices: string[];
    try {
      outcomes = JSON.parse(market.outcomes ?? "[]");
      outcomePrices = JSON.parse(market.outcomePrices ?? "[]");
    } catch {
      return null;
    }
    if (outcomes.length !== 2 || outcomePrices.length !== 2) return null;

    const upIdx = outcomes.findIndex((o) => /^up$/i.test(o.trim()));
    const downIdx = outcomes.findIndex((o) => /^down$/i.test(o.trim()));
    if (upIdx === -1 || downIdx === -1) return null;

    const upPrice = Number(outcomePrices[upIdx]);
    const downPrice = Number(outcomePrices[downIdx]);
    if (upPrice > 0.05 && upPrice < 0.95) return null; // ещё не устаканилось

    return upPrice > downPrice ? "Up" : "Down";
  } catch (err) {
    console.error(`[resolve] ошибка ${eventSlug}:`, (err as Error).message);
    return null;
  }
}

// ─────────────────────────── Основной класс ───────────────────────────

class ResearchLab {
  private watcher: PriceWatcher | null = null;
  private tokenIndex = new Map<string, TokenInfo>();
  private lastTokenIds: string[] = [];

  private quotes = new Map<string, Quote>(); // tokenId -> последние известные bid/ask
  private peaks = new Map<string, number>(); // `${slug}:${side}` -> максимальная цена токена
  private openPrices = new Map<string, number>(); // slug -> цена монеты на открытии окна
  private touchStates = new Map<string, { touchedHigh: boolean; touchedCorridor: boolean; leftAfterTouch: boolean }>();
  private firedKeys = new Set<string>();

  private pending = new Map<string, PendingMarket>();
  private settled = new Set<string>();

  private agg: StatMap = {}; // `${idea}|${combo}|${coin}`
  private conf: StatMap = {}; // `${idea}|c05|${n}` и `${idea}|c10|${n}`
  private agree: StatMap = {}; // `n|${k}` и `set|${1+2+4}`
  private arbAgg: Record<string, ArbAgg> = {};

  private marketsSeenCount = 0;
  private resolvedCount = 0;
  private updateCount = 0;

  // ───── сохранение / загрузка ─────

  saveState(): void {
    try {
      const data = {
        savedAt: Date.now(),
        agg: this.agg,
        conf: this.conf,
        agree: this.agree,
        arbAgg: this.arbAgg,
        pending: [...this.pending.entries()],
        settled: [...this.settled].slice(-MAX_SETTLED_REMEMBERED),
        marketsSeenCount: this.marketsSeenCount,
        resolvedCount: this.resolvedCount,
        updateCount: this.updateCount,
      };
      const tmpFile = `${STATE_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(data), "utf-8");
      fs.renameSync(tmpFile, STATE_FILE);
    } catch (err) {
      console.error("[saveState] ошибка сохранения:", (err as Error).message);
    }
  }

  loadState(): void {
    if (!fs.existsSync(STATE_FILE)) {
      console.log("[loadState] файл состояния не найден — начинаем с нуля.");
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      this.agg = data.agg ?? {};
      this.conf = data.conf ?? {};
      this.agree = data.agree ?? {};
      this.arbAgg = data.arbAgg ?? {};
      this.pending = new Map(data.pending ?? []);
      this.settled = new Set(data.settled ?? []);
      this.marketsSeenCount = data.marketsSeenCount ?? 0;
      this.resolvedCount = data.resolvedCount ?? 0;
      this.updateCount = data.updateCount ?? 0;

      for (const [slug, p] of this.pending) {
        for (const e of p.entries) this.firedKeys.add(`${e.idea}|${e.combo}|${slug}|${e.side}`);
      }
      console.log(
        `[loadState] восстановлено: рынков обработано ${this.resolvedCount}, ждут резолва ${this.pending.size}.`,
      );
    } catch (err) {
      console.error("[loadState] ошибка загрузки, начинаем с нуля:", (err as Error).message);
    }
  }

  // ───── рынки ─────

  private ensurePending(market: CryptoUpDownMarket): PendingMarket | null {
    if (this.settled.has(market.eventSlug)) return null;
    let p = this.pending.get(market.eventSlug);
    if (!p) {
      if (market.closeTimeMs <= Date.now()) return null;
      p = { closeTimeMs: market.closeTimeMs, coin: market.coin, entries: [], arb: null };
      this.pending.set(market.eventSlug, p);
      this.marketsSeenCount++;
    }
    return p;
  }

  private dropPending(slug: string): void {
    const p = this.pending.get(slug);
    if (p) {
      for (const e of p.entries) this.firedKeys.delete(`${e.idea}|${e.combo}|${slug}|${e.side}`);
    }
    this.pending.delete(slug);
    this.settled.add(slug);
  }

  async refreshMarkets(): Promise<void> {
    let allMarkets: CryptoUpDownMarket[];
    try {
      allMarkets = await discoverCryptoUpDownMarkets(TIMEFRAMES_TO_DISCOVER);
    } catch (err) {
      console.error("[refresh] ошибка:", (err as Error).message);
      return;
    }

    const now = Date.now();
    const markets = allMarkets.filter(
      (m) =>
        isIncludedCoin(m.coin) &&
        m.windowMinutes === TARGET_WINDOW_MINUTES &&
        m.closeTimeMs - now <= observeWindowMs(m.windowMinutes),
    );

    this.tokenIndex = buildTokenIndex(markets);
    const tokenIds = [...this.tokenIndex.keys()].sort();

    for (const m of markets) this.ensurePending(m);

    // чистим данные для рынков, которых больше нет в наблюдении
    const activeSlugs = new Set(markets.map((m) => m.eventSlug));
    for (const slug of this.openPrices.keys()) {
      if (!activeSlugs.has(slug)) this.openPrices.delete(slug);
    }
    for (const key of this.touchStates.keys()) {
      const slug = key.split(":")[1];
      if (!activeSlugs.has(slug)) this.touchStates.delete(key);
    }
    for (const key of this.peaks.keys()) {
      const slug = key.split(":")[0];
      if (!activeSlugs.has(slug)) this.peaks.delete(key);
    }
    for (const tokenId of this.quotes.keys()) {
      if (!this.tokenIndex.has(tokenId)) this.quotes.delete(tokenId);
    }

    console.log(
      `[refresh] наблюдаем 5-мин рынков: ${markets.length} (${tokenIds.length} токенов), ждём резолва: ${this.pending.size}`,
    );

    const sameAsLastTime =
      tokenIds.length === this.lastTokenIds.length && tokenIds.every((id, i) => id === this.lastTokenIds[i]);
    if (sameAsLastTime && this.watcher) return;

    this.lastTokenIds = tokenIds;
    this.watcher?.stop();

    if (tokenIds.length === 0) {
      this.watcher = null;
      return;
    }

    this.watcher = new PriceWatcher(tokenIds, (u) => this.onPriceUpdate(u));
    this.watcher.start();
  }

  // ───── запись входа ─────

  private record(
    p: PendingMarket,
    idea: string,
    combo: string,
    market: CryptoUpDownMarket,
    side: "Up" | "Down",
    ask: number,
    secToClose: number,
    getConf: () => { c05: number; c10: number },
  ): void {
    const key = `${idea}|${combo}|${market.eventSlug}|${side}`;
    if (this.firedKeys.has(key)) return;
    this.firedKeys.add(key);
    const c = getConf();
    p.entries.push({
      idea,
      combo,
      coin: market.coin,
      side,
      ts: Date.now(),
      price: ask,
      sec: Math.round(secToClose),
      c05: c.c05,
      c10: c.c10,
    });
  }

  // ───── обработка каждого апдейта цены ─────

  private onPriceUpdate(update: PriceUpdate): void {
    this.updateCount++;

    const info = this.tokenIndex.get(update.tokenId);
    if (!info) return;
    const { market, side } = info;
    const now = Date.now();
    const secToClose = (market.closeTimeMs - now) / 1000;

    // последние известные bid/ask по токену
    const q = this.quotes.get(update.tokenId) ?? { bid: null, ask: null };
    if (typeof update.bestBid === "number") q.bid = update.bestBid;
    if (typeof update.bestAsk === "number") q.ask = update.bestAsk;
    this.quotes.set(update.tokenId, q);

    // "цена" для условий коридора — как в боте: bestBid, иначе bestAsk
    const price = update.bestBid ?? update.bestAsk;
    if (price === null || price === undefined) return;

    // максимум цены токена за время наблюдения (для идеи «паника»)
    const peakKey = `${market.eventSlug}:${side}`;
    if (price > (this.peaks.get(peakKey) ?? 0)) this.peaks.set(peakKey, price);

    // память для профилей "touch-drop" и "retouch" — обновляется всегда, как в боте
    for (const prof of BOT_PROFILES) {
      if (prof.priceMode !== "touch-drop" && prof.priceMode !== "retouch") continue;
      const key = `${prof.id}:${market.eventSlug}:${side}`;
      let st = this.touchStates.get(key);
      if (!st) {
        st = { touchedHigh: false, touchedCorridor: false, leftAfterTouch: false };
        this.touchStates.set(key, st);
      }
      if (prof.priceMode === "touch-drop") {
        if (price >= (prof.touchAbove ?? 0.995)) st.touchedHigh = true;
      } else {
        const low = prof.priceLow ?? DEFAULT_LOW;
        const high = prof.priceHigh ?? DEFAULT_HIGH;
        if (price >= low && price <= high) st.touchedCorridor = true;
        if (st.touchedCorridor && price < (prof.retouchDropBelow ?? 0.9)) st.leftAfterTouch = true;
      }
    }

    if (secToClose < 0) return;

    const p = this.ensurePending(market);
    if (!p) return;

    // арбитраж: сумма лучших ask обеих сторон
    const upQ = this.quotes.get(market.upTokenId);
    const downQ = this.quotes.get(market.downTokenId);
    if (upQ && downQ && upQ.ask !== null && downQ.ask !== null && upQ.ask > 0 && downQ.ask > 0) {
      const sum = upQ.ask + downQ.ask;
      if (!p.arb) p.arb = { minSum: sum, sec99: null };
      if (sum < p.arb.minSum) p.arb.minSum = sum;
      if (sum <= 0.99 + 1e-9 && p.arb.sec99 === null) p.arb.sec99 = secToClose;
    }

    // дальше нужен ask (по нему мы реально купили бы) и данные по монете
    const ask = q.ask;
    if (ask === null || ask <= 0 || ask > 0.999) return;

    const feed = PRICE_FEEDS[market.coin];
    if (!feed) return;

    const openTimeMs = market.closeTimeMs - market.windowMinutes * 60 * 1000;
    let openPrice = this.openPrices.get(market.eventSlug);
    if (openPrice === undefined) {
      const op = feed.getPriceAt(openTimeMs);
      if (op === null) return;
      openPrice = op;
      this.openPrices.set(market.eventSlug, openPrice);
    }
    const coinNow = feed.getLatestPrice();
    if (coinNow === null) return;
    const pctMove = (coinNow - openPrice) / openPrice;
    const dirMove = side === "Up" ? pctMove : -pctMove; // плюс = монета идёт в сторону токена

    // ленивые вычисления — один раз на апдейт
    let volCache: number | null | undefined;
    const getVol = (): number | null => {
      if (volCache === undefined) volCache = volTracker.getRecentVolatility(market.coin, now);
      return volCache;
    };
    let confCache: { c05: number; c10: number } | undefined;
    const getConf = (): { c05: number; c10: number } => {
      if (confCache === undefined) {
        let c05 = 0;
        let c10 = 0;
        for (const c of INCLUDED_COINS) {
          if (c === market.coin) continue;
          const f = PRICE_FEEDS[c];
          const o = f.getPriceAt(openTimeMs);
          const n = f.getLatestPrice();
          if (o === null || n === null || o === 0) continue;
          const mv = side === "Up" ? (n - o) / o : (o - n) / o;
          if (mv >= CONFIRM_LEVEL_1) c05++;
          if (mv >= CONFIRM_LEVEL_2) c10++;
        }
        confCache = { c05, c10 };
      }
      return confCache;
    };

    // ── 1. «Запас» ──
    if (price >= MARGIN_PRICE_LOW && price <= MARGIN_PRICE_HIGH && ask <= MARGIN_PRICE_HIGH && dirMove > 0) {
      const vol = getVol();
      if (vol !== null && vol > 1e-6) {
        const z = dirMove / (vol * Math.sqrt(Math.max(secToClose, 1) / 300));
        for (const w of MARGIN_WINDOWS) {
          if (secToClose > w) continue;
          for (const zl of Z_LEVELS) {
            if (z < zl) continue;
            this.record(p, "margin", `z≥${zl.toFixed(1)} / ${w}с`, market, side, ask, secToClose, getConf);
          }
        }
      }
    }

    // ── 2. «Недооценка» ──
    if (dirMove > 0) {
      const band = findBand(CHEAP_BANDS, ask);
      if (band) {
        for (const w of CHEAP_WINDOWS) {
          if (secToClose > w) continue;
          for (const thr of CHEAP_THRESHOLDS) {
            if (dirMove < thr) continue;
            this.record(
              p,
              "cheap",
              `${pctLabel(thr)} / ${w}с / ${band[0].toFixed(2)}-${band[1].toFixed(2)}`,
              market,
              side,
              ask,
              secToClose,
              getConf,
            );
          }
        }
      }
    }

    // ── 3. «Паника без разворота» ──
    if (dirMove > 0 && (this.peaks.get(peakKey) ?? 0) >= PANIC_PEAK) {
      const band = findBand(PANIC_BANDS, ask);
      if (band) {
        for (const w of PANIC_WINDOWS) {
          if (secToClose > w) continue;
          for (const thr of PANIC_THRESHOLDS) {
            if (dirMove < thr) continue;
            this.record(
              p,
              "panic",
              `${pctLabel(thr)} / ${w}с / ${band[0].toFixed(2)}-${band[1].toFixed(2)}`,
              market,
              side,
              ask,
              secToClose,
              getConf,
            );
          }
        }
      }
    }

    // ── 4. «Импульс последних секунд» ──
    if (secToClose <= 180 && dirMove > 0 && ask >= IMPULSE_ASK_MIN && ask <= IMPULSE_ASK_MAX) {
      for (const lb of IMPULSE_LOOKBACKS_SEC) {
        const p0 = feed.getPriceAt(now - lb * 1000);
        if (p0 === null || p0 === 0) continue;
        const imp = (coinNow - p0) / p0;
        const dirImp = side === "Up" ? imp : -imp;
        if (dirImp <= 0) continue;
        for (const w of IMPULSE_WINDOWS) {
          if (secToClose > w) continue;
          for (const thr of IMPULSE_THRESHOLDS) {
            if (dirImp < thr) continue;
            this.record(p, "impulse", `${pctLabel(thr)} за ${lb}с / ${w}с`, market, side, ask, secToClose, getConf);
          }
        }
      }
    }

    // ── 7. Моделирование профилей бота (для «согласия профилей» и подтверждения монетами) ──
    for (const prof of BOT_PROFILES) {
      const win = prof.windowSec[market.coin];
      if (win === undefined || secToClose > win) continue;

      const low = prof.priceLow ?? DEFAULT_LOW;
      const high = prof.priceHigh ?? DEFAULT_HIGH;
      if (ask > high) continue; // потолок покупки — как maxBuyPrice в боте

      let priceOk: boolean;
      if (prof.priceMode === "none") {
        priceOk = true;
      } else if (prof.priceMode === "touch-drop") {
        const st = this.touchStates.get(`${prof.id}:${market.eventSlug}:${side}`);
        priceOk = (st?.touchedHigh ?? false) && price >= low && price <= high;
      } else if (prof.priceMode === "retouch") {
        const st = this.touchStates.get(`${prof.id}:${market.eventSlug}:${side}`);
        priceOk = (st?.touchedCorridor ?? false) && (st?.leftAfterTouch ?? false) && price >= low && price <= high;
      } else {
        priceOk = price >= low && price <= high;
      }
      if (!priceOk) continue;

      const pv = prof.param[market.coin];
      if (pv === undefined) continue;
      let thr: number;
      if (prof.mode === "adaptive") {
        const v = getVol();
        if (v === null) continue;
        thr = pv * v;
      } else {
        thr = pv;
      }

      const passes = side === "Up" ? pctMove >= thr : pctMove <= -thr;
      if (!passes) continue;

      this.record(p, `bot${prof.id}`, "профиль", market, side, ask, secToClose, getConf);
    }
  }

  // ───── резолв ─────

  private settle(slug: string, winner: "Up" | "Down"): void {
    const p = this.pending.get(slug);
    if (!p) return;

    const earliest = new Map<string, LabEntry>(); // `${idea}|${side}` -> самый ранний вход
    for (const e of p.entries) {
      const won = e.side === winner;
      const roi = won ? (1 - e.price) / e.price : -1;
      bump(this.agg, `${e.idea}|${e.combo}|${e.coin}`, won, roi);

      const k = `${e.idea}|${e.side}`;
      const ex = earliest.get(k);
      if (!ex || e.ts < ex.ts) earliest.set(k, e);
    }

    // подтверждение другими монетами — одна запись на (идея, сторона), самый ранний вход
    for (const e of earliest.values()) {
      const won = e.side === winner;
      const roi = won ? (1 - e.price) / e.price : -1;
      bump(this.conf, `${e.idea}|c05|${e.c05}`, won, roi);
      bump(this.conf, `${e.idea}|c10|${e.c10}`, won, roi);
    }

    // согласие профилей бота — по каждой стороне рынка
    const botBySide = new Map<string, LabEntry[]>();
    for (const e of earliest.values()) {
      if (!e.idea.startsWith("bot")) continue;
      const list = botBySide.get(e.side) ?? [];
      list.push(e);
      botBySide.set(e.side, list);
    }
    for (const [side, list] of botBySide) {
      const ids = list.map((e) => e.idea.slice(3)).sort();
      const first = list.reduce((a, b) => (a.ts <= b.ts ? a : b));
      const won = side === winner;
      const roi = won ? (1 - first.price) / first.price : -1;
      bump(this.agree, `n|${ids.length}`, won, roi);
      bump(this.agree, `set|${ids.join("+")}`, won, roi);
    }

    // арбитраж
    if (p.arb) {
      const a = this.arbAgg[p.coin] ?? (this.arbAgg[p.coin] = { total: 0, minSumTotal: 0, h99: 0, h98: 0, h97: 0, h95: 0, sec99Sum: 0 });
      a.total++;
      a.minSumTotal += p.arb.minSum;
      if (p.arb.minSum <= 0.99 + 1e-9) {
        a.h99++;
        a.sec99Sum += p.arb.sec99 ?? 0;
      }
      if (p.arb.minSum <= 0.98 + 1e-9) a.h98++;
      if (p.arb.minSum <= 0.97 + 1e-9) a.h97++;
      if (p.arb.minSum <= 0.95 + 1e-9) a.h95++;
    }

    this.dropPending(slug);
    this.resolvedCount++;
  }

  async checkResolutions(): Promise<void> {
    const now = Date.now();
    const toCheck: string[] = [];
    for (const [slug, p] of this.pending) {
      const age = now - p.closeTimeMs;
      if (age >= RESOLVE_GIVE_UP_MS) {
        this.dropPending(slug);
        continue;
      }
      if (age >= RESOLVE_CHECK_DELAY_SEC * 1000) toCheck.push(slug);
    }

    let changed = false;
    for (const slug of toCheck) {
      const winner = await resolveWinner(slug);
      if (winner === null) continue;
      this.settle(slug, winner);
      changed = true;
    }
    if (changed) this.saveState();
  }

  // ───── отчёты ─────

  private collect(idea: string): { combo: string; coin: string; w: number; t: number; roi: number }[] {
    const out: { combo: string; coin: string; w: number; t: number; roi: number }[] = [];
    for (const [key, s] of Object.entries(this.agg)) {
      if (!key.startsWith(`${idea}|`)) continue;
      const parts = key.split("|");
      out.push({ combo: parts[1], coin: parts[2], w: s.w, t: s.t, roi: s.roi });
    }
    return out;
  }

  private topLines(list: { combo: string; w: number; t: number; roi: number }[], n: number): string[] {
    const top = list
      .filter((e) => e.t >= MIN_TRADES_FOR_TOP)
      .sort((a, b) => b.w / b.t - a.w / a.t || b.t - a.t)
      .slice(0, n);
    if (top.length === 0) return [`  пока недостаточно данных (нужно ≥${MIN_TRADES_FOR_TOP} записей на комбинацию)`];
    return top.map(
      (e, i) => `  ${i + 1}. ${e.combo} — ${winPct(e.w, e.t)} (${e.w}/${e.t}), доходность ${roiLabel(e.roi, e.t)}`,
    );
  }

  private pooled(idea: string): { combo: string; w: number; t: number; roi: number }[] {
    const m = new Map<string, { combo: string; w: number; t: number; roi: number }>();
    for (const s of this.collect(idea)) {
      const cur = m.get(s.combo) ?? { combo: s.combo, w: 0, t: 0, roi: 0 };
      cur.w += s.w;
      cur.t += s.t;
      cur.roi += s.roi;
      m.set(s.combo, cur);
    }
    return [...m.values()];
  }

  private buildIdeaReport(idea: string, title: string, note: string): string {
    const stats = this.collect(idea);
    const total = stats.reduce((a, s) => a + s.t, 0);
    const lines: string[] = [];
    lines.push(`<b>📊 ${title}</b>`);
    lines.push(note);
    lines.push(`Записей входа по всем комбинациям (после резолва): ${total}`);
    lines.push("");
    lines.push("<b>── Все монеты вместе: топ-5 ──</b>");
    lines.push(...this.topLines(this.pooled(idea), 5));
    lines.push("");
    for (const coin of INCLUDED_COINS) {
      lines.push(`<b>── ${coin}: топ-5 ──</b>`);
      lines.push(...this.topLines(stats.filter((s) => s.coin === coin), 5));
      lines.push("");
    }
    lines.push("Доходность — средний результат на $1 ставки (без комиссий).");
    return lines.join("\n");
  }

  buildMarginReport(): string {
    return this.buildIdeaReport(
      "margin",
      "Идея «Запас» (z вместо порога)",
      "z = движение монеты в сторону токена ÷ (типичное 5-мин движение × √(осталось/300)). Один параметр на все монеты. Цена токена 0.97-0.98, вход по ask.",
    );
  }

  buildCheapReport(): string {
    return this.buildIdeaReport(
      "cheap",
      "Идея «Недооценка»",
      "Монета уже прошла порог в сторону токена, а ask токена 0.85-0.96. Формат: порог / окно / диапазон цены ask.",
    );
  }

  buildPanicReport(): string {
    return this.buildIdeaReport(
      "panic",
      "Идея «Паника без разворота»",
      "Токен был ≥0.97, потом ask просел до 0.85-0.95, а монета всё ещё за порогом движения. Формат: порог / окно / диапазон цены ask.",
    );
  }

  buildImpulseReport(): string {
    return this.buildIdeaReport(
      "impulse",
      "Идея «Импульс последних секунд»",
      "Монета прошла N% за последние 15 или 30с в сторону токена, при этом от открытия окна она тоже в эту сторону; ask токена 0.60-0.98. Формат: рывок за N секунд / окно.",
    );
  }

  buildArbReport(): string {
    const lines: string[] = [];
    lines.push("<b>📊 Идея «Арбитраж Up+Down»</b>");
    lines.push(
      "Считаем, как часто сумма лучших ask обеих сторон оказывалась ≤ 0.99 / 0.98 / 0.97 / 0.95. Глубина стакана не учитывается (сколько акций доступно по этой цене — неизвестно), поэтому это верхняя оценка.",
    );
    lines.push("");

    const all: ArbAgg = { total: 0, minSumTotal: 0, h99: 0, h98: 0, h97: 0, h95: 0, sec99Sum: 0 };
    const rowFor = (label: string, a: ArbAgg): string[] => {
      if (a.total === 0) return [`<b>── ${label} ──</b>`, "  пока нет данных", ""];
      const pct = (n: number) => `${n} (${((100 * n) / a.total).toFixed(1)}%)`;
      const sec = a.h99 > 0 ? `, в среднем за ${(a.sec99Sum / a.h99).toFixed(0)}с до закрытия` : "";
      return [
        `<b>── ${label} ──</b>`,
        `  рынков: ${a.total}, средняя минимальная сумма: ${(a.minSumTotal / a.total).toFixed(3)}`,
        `  сумма ≤ 0.99: ${pct(a.h99)}${sec}`,
        `  сумма ≤ 0.98: ${pct(a.h98)}`,
        `  сумма ≤ 0.97: ${pct(a.h97)}`,
        `  сумма ≤ 0.95: ${pct(a.h95)}`,
        "",
      ];
    };

    for (const coin of INCLUDED_COINS) {
      const a = this.arbAgg[coin];
      if (a) {
        all.total += a.total;
        all.minSumTotal += a.minSumTotal;
        all.h99 += a.h99;
        all.h98 += a.h98;
        all.h97 += a.h97;
        all.h95 += a.h95;
        all.sec99Sum += a.sec99Sum;
      }
    }
    lines.push(...rowFor("Все монеты", all));
    for (const coin of INCLUDED_COINS) {
      lines.push(...rowFor(coin, this.arbAgg[coin] ?? { total: 0, minSumTotal: 0, h99: 0, h98: 0, h97: 0, h95: 0, sec99Sum: 0 }));
    }
    return lines.join("\n");
  }

  private ideaLabel(idea: string): string {
    switch (idea) {
      case "margin":
        return "Запас";
      case "cheap":
        return "Недооценка";
      case "panic":
        return "Паника без разворота";
      case "impulse":
        return "Импульс";
      default:
        return idea.startsWith("bot") ? `Профиль ${idea.slice(3)} (бот)` : idea;
    }
  }

  buildConfirmReport(): string {
    const lines: string[] = [];
    lines.push("<b>📊 Подтверждение другими монетами</b>");
    lines.push(
      "Сколько ДРУГИХ монет (из 4) в момент входа идут в ту же сторону не менее чем на 0.05% / 0.10% от открытия окна. Формат: подтвердили монет: выигрыш/всего, винрейт. Одна запись на ситуацию (самый ранний вход идеи).",
    );
    lines.push("");

    const ideas = ["margin", "cheap", "panic", "impulse", "bot1", "bot2", "bot3", "bot4", "bot5"];
    for (const idea of ideas) {
      lines.push(`<b>── ${this.ideaLabel(idea)} ──</b>`);
      let any = false;
      for (const [lvl, label] of [
        ["c05", "порог 0.05%"],
        ["c10", "порог 0.10%"],
      ] as const) {
        const parts: string[] = [];
        for (let n = 0; n <= 4; n++) {
          const s = this.conf[`${idea}|${lvl}|${n}`];
          if (!s || s.t === 0) continue;
          parts.push(`${n}: ${s.w}/${s.t} ${winPct(s.w, s.t)}`);
        }
        if (parts.length > 0) {
          any = true;
          lines.push(`  ${label} → ${parts.join(" | ")}`);
        }
      }
      if (!any) lines.push("  пока нет данных");
      lines.push("");
    }
    return lines.join("\n");
  }

  buildProfilesReport(): string {
    const lines: string[] = [];
    lines.push("<b>📊 Профили бота и согласие профилей</b>");
    lines.push("Моделирование 5 профилей бота: вход по ask, потолок покупки как в боте, держим до резолва.");
    lines.push("");
    lines.push("<b>── Каждый профиль отдельно (выигрыш/всего, винрейт, доходность на $1) ──</b>");
    for (const prof of BOT_PROFILES) {
      const idea = `bot${prof.id}`;
      const stats = this.collect(idea);
      const parts: string[] = [];
      let tw = 0;
      let tt = 0;
      let tr = 0;
      for (const coin of INCLUDED_COINS) {
        const s = stats.find((x) => x.coin === coin);
        if (!s) continue;
        tw += s.w;
        tt += s.t;
        tr += s.roi;
        parts.push(`${COIN_SHORT[coin]} ${s.w}/${s.t} ${winPct(s.w, s.t)}`);
      }
      lines.push(`  Профиль ${prof.id}: всего ${tw}/${tt} ${winPct(tw, tt)}, доходность ${roiLabel(tr, tt)}`);
      if (parts.length > 0) lines.push(`     ${parts.join(" | ")}`);
    }
    lines.push("");

    lines.push("<b>── Согласие: сколько профилей дали сигнал на одну сторону рынка ──</b>");
    lines.push("(считаются сигналы за весь рынок до закрытия; доходность — по цене самого раннего входа)");
    let anyN = false;
    for (let n = 1; n <= BOT_PROFILES.length; n++) {
      const s = this.agree[`n|${n}`];
      if (!s || s.t === 0) continue;
      anyN = true;
      lines.push(`  профилей: ${n} → ${s.w}/${s.t} ${winPct(s.w, s.t)}, доходность ${roiLabel(s.roi, s.t)}`);
    }
    if (!anyN) lines.push("  пока нет данных");
    lines.push("");

    lines.push("<b>── Конкретные сочетания профилей (минимум 5 случаев) ──</b>");
    const sets = Object.entries(this.agree)
      .filter(([k, s]) => k.startsWith("set|") && s.t >= 5)
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, 12);
    if (sets.length === 0) {
      lines.push("  пока недостаточно данных");
    } else {
      for (const [k, s] of sets) {
        lines.push(`  профили ${k.slice(4)} → ${s.w}/${s.t} ${winPct(s.w, s.t)}, доходность ${roiLabel(s.roi, s.t)}`);
      }
    }
    return lines.join("\n");
  }

  buildSummaryReport(): string {
    const lines: string[] = [];
    lines.push("<b>🧪 LAB: сводка</b>");
    lines.push(
      `Рынков обработано: ${this.resolvedCount} (увидено всего: ${this.marketsSeenCount}), ждут резолва: ${this.pending.size}`,
    );
    lines.push("");

    const ideas: [string, string][] = [
      ["margin", "Запас"],
      ["cheap", "Недооценка"],
      ["panic", "Паника без разворота"],
      ["impulse", "Импульс"],
    ];
    for (const [idea, label] of ideas) {
      lines.push(`<b>── ${label}: топ-3 (все монеты вместе) ──</b>`);
      lines.push(...this.topLines(this.pooled(idea), 3));
      lines.push("");
    }

    const arbAll = Object.values(this.arbAgg).reduce(
      (acc, a) => ({ total: acc.total + a.total, h99: acc.h99 + a.h99 }),
      { total: 0, h99: 0 },
    );
    lines.push("<b>── Арбитраж ──</b>");
    lines.push(
      arbAll.total > 0
        ? `  сумма ask ≤ 0.99 была на ${arbAll.h99} из ${arbAll.total} рынков (${((100 * arbAll.h99) / arbAll.total).toFixed(1)}%)`
        : "  пока нет данных",
    );
    lines.push("");

    lines.push("<b>── Профили бота (моделирование) ──</b>");
    for (const prof of BOT_PROFILES) {
      let tw = 0;
      let tt = 0;
      let tr = 0;
      for (const s of this.collect(`bot${prof.id}`)) {
        tw += s.w;
        tt += s.t;
        tr += s.roi;
      }
      lines.push(`  Профиль ${prof.id}: ${tw}/${tt} ${winPct(tw, tt)}, доходность ${roiLabel(tr, tt)}`);
    }
    lines.push("");
    lines.push('Все команды: "лаб помощь"');
    return lines.join("\n");
  }

  buildHelp(): string {
    return [
      "<b>🧪 LAB — команды</b>",
      "лаб — сводка по всем идеям",
      "лаб запас — идея «Запас» (z вместо порога)",
      "лаб дешево — «Недооценка» (токен дешевле 0.96)",
      "лаб паника — «Паника без разворота»",
      "лаб импульс — «Импульс последних секунд»",
      "лаб арб — «Арбитраж Up+Down»",
      "лаб монеты — подтверждение другими монетами",
      "лаб профили — профили бота и согласие профилей",
      "лаб помощь — этот список",
    ].join("\n");
  }

  start(): void {
    this.loadState();
    this.refreshMarkets();
    setInterval(() => this.refreshMarkets(), MARKET_REFRESH_MS);
    setInterval(() => this.checkResolutions(), 30 * 1000);
    setInterval(() => this.saveState(), AUTOSAVE_INTERVAL_MS);
    setInterval(() => {
      console.log(
        `--- статус: апдейтов ${this.updateCount}, рынков обработано ${this.resolvedCount}, ждут резолва ${this.pending.size} ---`,
      );
    }, 60 * 1000);
  }
}

// ─────────────────────────── Telegram ───────────────────────────

const TELEGRAM_MAX_CHUNK = 3500;

function splitReportIntoChunks(report: string, maxLen: number = TELEGRAM_MAX_CHUNK): string[] {
  const lines = report.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
}

async function sendReportToTelegram(
  telegram: ReturnType<typeof createTelegramNotifier>,
  report: string,
): Promise<void> {
  const chunks = splitReportIntoChunks(report);
  for (let i = 0; i < chunks.length; i++) {
    const text = i === 0 ? chunks[i] : `<b>...продолжение (${i + 1}/${chunks.length})</b>\n\n${chunks[i]}`;
    try {
      await telegram?.send(text);
    } catch (err) {
      console.error(`[sendReport] ошибка отправки части ${i + 1}/${chunks.length}:`, (err as Error).message);
    }
  }
}

function normalizeCmd(raw: string): string {
  return raw.toLowerCase().replace(/ё/g, "е").replace(/@\w+/g, "").replace(/\s+/g, " ").trim();
}

const COMMANDS: Record<string, string[]> = {
  summary: ["лаб", "/lab"],
  margin: ["лаб запас", "/lab_margin"],
  cheap: ["лаб дешево", "/lab_cheap"],
  panic: ["лаб паника", "/lab_panic"],
  impulse: ["лаб импульс", "/lab_impulse"],
  arb: ["лаб арб", "/lab_arb"],
  confirm: ["лаб монеты", "/lab_coins"],
  profiles: ["лаб профили", "/lab_profiles"],
  help: ["лаб помощь", "/lab_help"],
};

async function pollTelegramCommands(
  botToken: string,
  chatId: string,
  telegram: ReturnType<typeof createTelegramNotifier>,
  lab: ResearchLab,
): Promise<void> {
  let offset = 0;
  const apiUrl = `https://api.telegram.org/bot${botToken}/getUpdates`;

  for (;;) {
    try {
      const resp = await fetch(`${apiUrl}?offset=${offset}&timeout=25`);
      if (!resp.ok) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const data = await resp.json();
      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text || String(msg.chat?.id) !== String(chatId)) continue;
        const text = normalizeCmd(msg.text);

        const cmd = Object.keys(COMMANDS).find((k) => COMMANDS[k].includes(text));
        if (!cmd) continue;
        console.log(`[telegram] команда: "${msg.text}" → ${cmd}`);

        let report: string;
        switch (cmd) {
          case "summary":
            report = lab.buildSummaryReport();
            break;
          case "margin":
            report = lab.buildMarginReport();
            break;
          case "cheap":
            report = lab.buildCheapReport();
            break;
          case "panic":
            report = lab.buildPanicReport();
            break;
          case "impulse":
            report = lab.buildImpulseReport();
            break;
          case "arb":
            report = lab.buildArbReport();
            break;
          case "confirm":
            report = lab.buildConfirmReport();
            break;
          case "profiles":
            report = lab.buildProfilesReport();
            break;
          default:
            report = lab.buildHelp();
        }
        await sendReportToTelegram(telegram, report);
      }
    } catch (err) {
      console.error("[telegram poll] ошибка:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ─────────────────────────── Запуск ───────────────────────────

async function main() {
  console.log("=== LAB: исследовательский парсер идей запущен (не торгует) ===");
  console.log("Идеи: запас (z), недооценка, паника без разворота, импульс, арбитраж, подтверждение монетами, согласие профилей.");

  btcPriceFeed.start();
  ethPriceFeed.start();
  solPriceFeed.start();
  xrpPriceFeed.start();
  dogePriceFeed.start();
  volTracker.start();

  const logger = createLogger(false);
  const botToken = process.env.LAB_TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.LAB_TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
  const telegram = createTelegramNotifier(botToken, chatId, logger);

  const lab = new ResearchLab();
  lab.start();

  if (telegram && botToken && chatId) {
    console.log('Telegram включён. Команды начинаются со слова "лаб" (список: "лаб помощь").');
    pollTelegramCommands(botToken, chatId, telegram, lab);
  } else {
    console.log("Telegram не настроен — отчёты недоступны (задай LAB_TELEGRAM_BOT_TOKEN и LAB_TELEGRAM_CHAT_ID).");
  }

  const shutdown = () => {
    lab.saveState();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
  process.exit(1);
});
