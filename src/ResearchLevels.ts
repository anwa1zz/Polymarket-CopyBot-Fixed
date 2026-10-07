/**
 * Исследовательский модуль "УРОВНИ" (research-grid-levels.ts) — не торгует,
 * только собирает статистику. ПОЛНОСТЬЮ ОТДЕЛЬНЫЙ процесс от research-grid.ts
 * и от боевого fastFlip.ts — свой файл состояния (research-grid-levels-state.json),
 * ничего не пересекается с уже накопленными данными в других процессах.
 *
 * Проверяет альтернативные механики входа (не "движение + коридор 0.97-0.98",
 * как в основном research-grid.ts), а именно:
 *
 *   L1 "100→99 отскок"     — цена коснулась ~1.00, затем осела до ~0.99, входим на этом
 *   L2a "90-92"             — коридор цены токена 0.90-0.92
 *   L2b "92-95"             — коридор цены токена 0.92-0.95
 *   L3  "80-85"             — коридор цены токена 0.80-0.85
 *   L4  "без цены (%+время)" — вообще без фильтра по цене токена, только % движения монеты + время
 *   L5  "повторное касание 97-98" — коснулись 0.97-0.98, откатили ниже 0.90, вернулись снова
 *   L6  "средний коридор 45-55"   — цена токена ещё не определилась, ставка на опережение рынка
 *
 * Каждый уровень (кроме L4) комбинируется с той же сеткой порог×окно, что и в
 * основном research-grid.ts (THRESHOLDS × WINDOWS_SEC), чтобы результаты были
 * сравнимы напрямую. L4 использует ту же сетку порогов и окон, просто без
 * условия на цену токена вообще.
 *
 * Idea 8 (объём как активный фильтр) реализована как ОТДЕЛЬНЫЙ отчёт-разрез
 * ("объемгейт") — показывает винрейт каждого уровня, разбитый по тому, был ли
 * дисбаланс объёма в сторону нашей стороны сильным или нет, вместо того чтобы
 * жёстко зашивать это в критерий входа и множить и без того большую сетку.
 * Если разрез покажет явную разницу — тогда есть смысл сделать это жёстким
 * фильтром.
 *
 * Условие "сделки" — как в боевом боте и в research-grid.ts: держим ДО
 * ОФИЦИАЛЬНОГО РЕЗОЛВА, никакого раннего выхода/лимитки.
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  discoverCryptoUpDownMarkets,
  CryptoUpDownMarket,
} from "./cryptoMarketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { btcPriceFeed } from "./btcPriceFeed.js";
import { ethPriceFeed } from "./ethPriceFeed.js";
import { solPriceFeed } from "./solPriceFeed.js";
import { xrpPriceFeed } from "./xrpPriceFeed.js";
import { dogePriceFeed } from "./dogePriceFeed.js";
import { tradeFlowTracker } from "./tradeFlowTracker.js";
import { createTelegramNotifier } from "./telegram.js";
import { createLogger } from "./logger.js";

const STATE_FILE = path.resolve(process.cwd(), "research-grid-levels-state.json");
const AUTOSAVE_INTERVAL_MS = 60 * 1000;

const TARGET_WINDOW_MINUTES = 5;
const TIMEFRAMES_TO_DISCOVER = [{ suffixes: ["up-or-down-5m"], minutes: TARGET_WINDOW_MINUTES }];

// Та же сетка порог×окно, что в основном research-grid.ts — для прямой сравнимости.
const THRESHOLDS = [0.001, 0.0013, 0.0014, 0.0015, 0.002, 0.003]; // 0.10% .. 0.30%
const WINDOWS_SEC = [10, 30, 60, 90, 120, 180, 300];

const MIN_TRADES_FOR_TOP = 15;
const HIGH_WINRATE_BAR = 0.98;

function thresholdLabel(t: number): string {
  return `${(t * 100).toFixed(2)}%`;
}

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

const MARKET_REFRESH_MS = 30 * 1000;
const AUTO_REPORT_INTERVAL_MS = 30 * 60 * 1000;
const RESOLVE_CHECK_DELAY_SEC = 180;
const GAMMA_HOST = "https://gamma-api.polymarket.com";

const COMPACT_REPORT_TRIGGERS = ["уровни итог", "levels report", "/levelsreport"];
const FULL_GRID_TRIGGERS = ["уровни полная", "levels full grid", "/levelsgrid"];
const VOLUME_GATE_REPORT_TRIGGERS = ["объемгейт", "объёмгейт", "volume gate", "/volumegate"];

function observeWindowMs(windowMinutes: number): number {
  return (windowMinutes + 1) * 60 * 1000;
}

// ─── Описание уровней (idea 1,2,3,4,5,13) ───
type LevelKind = "corridor" | "corridor-retouch" | "touch-then-drop" | "no-price";

interface LevelDef {
  id: string;
  name: string;
  kind: LevelKind;
  // для "corridor" / "corridor-retouch": границы коридора цены токена
  low?: number;
  high?: number;
  // для "corridor-retouch": ниже какой цены считается "откатом" перед повторным заходом
  retouchDropBelow?: number;
  // для "touch-then-drop": порог касания сверху и коридор, в котором покупаем после отката
  touchAbove?: number;
}

const LEVELS: LevelDef[] = [
  { id: "L1", name: "100→99 отскок", kind: "touch-then-drop", touchAbove: 0.995, low: 0.985, high: 0.993 },
  { id: "L2a", name: "90-92", kind: "corridor", low: 0.90, high: 0.92 },
  { id: "L2b", name: "92-95", kind: "corridor", low: 0.92, high: 0.95 },
  { id: "L3", name: "80-85", kind: "corridor", low: 0.80, high: 0.85 },
  { id: "L4", name: "без цены (%+время)", kind: "no-price" },
  { id: "L5", name: "повторное касание 97-98", kind: "corridor-retouch", low: 0.97, high: 0.98, retouchDropBelow: 0.90 },
  { id: "L6", name: "средний коридор 45-55", kind: "corridor", low: 0.45, high: 0.55 },
];

interface TokenInfo {
  market: CryptoUpDownMarket;
  side: "Up" | "Down";
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

// Состояние касаний для L1/L5, по ключу `${levelId}:${eventSlug}:${side}`.
interface TouchState {
  touchedHigh: boolean; // для L1: касалась ли цена touchAbove
  touchedCorridor: boolean; // для L5: было ли уже касание коридора
  leftAfterTouch: boolean; // для L5: откатывала ли ниже retouchDropBelow после касания
}

interface LevelTradeEvent {
  levelId: string;
  pctThreshold: number;
  windowSec: number;
  eventSlug: string;
  coin: string;
  side: "Up" | "Down";
  priceAtEntry: number;
  entryTimestamp: number;
  determined: boolean;
  won: boolean | null;
  // Для отчёта "объемгейт" (idea 8) — дисбаланс объёма в момент входа, окно 90с.
  volumeImbalance90s: number | null;
}

export class LevelsResearchLogger {
  private watcher: PriceWatcher | null = null;
  private tokenIndex = new Map<string, TokenInfo>();
  private lastTokenIds: string[] = [];

  private trades = new Map<string, LevelTradeEvent>();
  private tradesList: LevelTradeEvent[] = [];

  private openPrices: Map<string, number> = new Map();
  private touchStates = new Map<string, TouchState>();

  private pendingResolution = new Map<string, { closeTimeMs: number }>();
  private marketsSeen = new Set<string>();
  private updateCount = 0;

  saveState(): void {
    try {
      const data = {
        savedAt: Date.now(),
        tradesList: this.tradesList,
        pendingResolution: [...this.pendingResolution.entries()],
        marketsSeen: [...this.marketsSeen],
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
      console.log("[loadState] файл состояния уровней не найден — начинаем с нуля.");
      return;
    }
    try {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const data = JSON.parse(raw);
      this.tradesList = data.tradesList ?? [];
      for (const t of this.tradesList as any[]) {
        if (t.volumeImbalance90s === undefined) t.volumeImbalance90s = null;
      }
      this.trades = new Map();
      for (const t of this.tradesList as LevelTradeEvent[]) {
        const key = `${t.levelId}_${t.pctThreshold}_${t.windowSec}:${t.eventSlug}:${t.side}`;
        this.trades.set(key, t);
      }
      this.pendingResolution = new Map(data.pendingResolution ?? []);
      this.marketsSeen = new Set(data.marketsSeen ?? []);
      this.updateCount = data.updateCount ?? 0;

      const savedAgoSec = data.savedAt ? Math.round((Date.now() - data.savedAt) / 1000) : "?";
      console.log(
        `[loadState] восстановлено сделок уровней: ${this.tradesList.length}, ждут резолва: ${this.pendingResolution.size} (сохранено ${savedAgoSec}с назад).`,
      );
    } catch (err) {
      console.error("[loadState] ошибка загрузки, начинаем с нуля:", (err as Error).message);
    }
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

    for (const m of markets) {
      this.marketsSeen.add(m.eventSlug);
      if (!this.pendingResolution.has(m.eventSlug)) {
        this.pendingResolution.set(m.eventSlug, { closeTimeMs: m.closeTimeMs });
      }
    }

    const activeSlugs = new Set(markets.map((m) => m.eventSlug));
    for (const slug of this.openPrices.keys()) {
      if (!activeSlugs.has(slug)) this.openPrices.delete(slug);
    }
    // чистим состояния касаний для рынков, которых больше нет
    for (const key of this.touchStates.keys()) {
      const slug = key.split(":")[1];
      if (!activeSlugs.has(slug)) this.touchStates.delete(key);
    }

    console.log(
      `[refresh] (уровни) наблюдаем (${INCLUDED_COINS.join("/")}) 5-мин рынков: ${markets.length} (${tokenIds.length} токенов), ` +
        `сделок открыто: ${this.tradesList.length}, ждём резолва: ${this.pendingResolution.size}`,
    );

    tradeFlowTracker.updateTokenIds(tokenIds);

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

  private recordEntryIfNew(
    levelId: string,
    pctThreshold: number,
    windowSec: number,
    market: CryptoUpDownMarket,
    side: "Up" | "Down",
    price: number,
    now: number,
    volumeImbalance90s: number | null,
  ): void {
    const key = `${levelId}_${pctThreshold}_${windowSec}:${market.eventSlug}:${side}`;
    if (this.trades.has(key)) return;

    const trade: LevelTradeEvent = {
      levelId,
      pctThreshold,
      windowSec,
      eventSlug: market.eventSlug,
      coin: market.coin,
      side,
      priceAtEntry: price,
      entryTimestamp: now,
      determined: false,
      won: null,
      volumeImbalance90s,
    };
    this.trades.set(key, trade);
    this.tradesList.push(trade);
  }

  /** Проверяет, удовлетворяет ли текущая цена токена условию конкретного уровня, обновляя состояние касаний при необходимости. */
  private checkLevelPriceCondition(level: LevelDef, price: number, stateKey: string): boolean {
    if (level.kind === "no-price") return true;

    if (level.kind === "corridor") {
      return price >= (level.low as number) && price <= (level.high as number);
    }

    if (level.kind === "touch-then-drop") {
      let state = this.touchStates.get(stateKey);
      if (!state) {
        state = { touchedHigh: false, touchedCorridor: false, leftAfterTouch: false };
        this.touchStates.set(stateKey, state);
      }
      if (price >= (level.touchAbove as number)) state.touchedHigh = true;
      if (!state.touchedHigh) return false; // ещё не было касания верха
      return price >= (level.low as number) && price <= (level.high as number);
    }

    if (level.kind === "corridor-retouch") {
      let state = this.touchStates.get(stateKey);
      if (!state) {
        state = { touchedHigh: false, touchedCorridor: false, leftAfterTouch: false };
        this.touchStates.set(stateKey, state);
      }
      const inCorridor = price >= (level.low as number) && price <= (level.high as number);
      if (inCorridor && !state.touchedCorridor) {
        state.touchedCorridor = true;
        return false; // первое касание — не входим, только запоминаем
      }
      if (state.touchedCorridor && price < (level.retouchDropBelow as number)) {
        state.leftAfterTouch = true;
      }
      if (state.touchedCorridor && state.leftAfterTouch && inCorridor) {
        return true; // повторное касание после реального отката — входим
      }
      return false;
    }

    return false;
  }

  private onPriceUpdate(update: PriceUpdate): void {
    this.updateCount++;

    const info = this.tokenIndex.get(update.tokenId);
    if (!info) return;
    const { market, side } = info;

    const price = update.bestBid ?? update.bestAsk;
    if (price === null) return;

    const feed = PRICE_FEEDS[market.coin];
    if (!feed) return;

    const now = Date.now();
    const secToClose = (market.closeTimeMs - now) / 1000;
    if (secToClose < 0) return;

    let openPrice = this.openPrices.get(market.eventSlug);
    if (openPrice === undefined) {
      const openTimeMs = market.closeTimeMs - market.windowMinutes * 60 * 1000;
      const p = feed.getPriceAt(openTimeMs);
      if (p === null) return;
      openPrice = p;
      this.openPrices.set(market.eventSlug, openPrice);
    }
    const coinNow = feed.getLatestPrice();
    if (coinNow === null) return;
    const pctMove = (coinNow - openPrice) / openPrice;

    let volumeImbalanceCache: number | null | undefined;
    const getVolumeImbalanceLazy = (): number | null => {
      if (volumeImbalanceCache === undefined) {
        const tokenId = side === "Up" ? market.upTokenId : market.downTokenId;
        const vi = tradeFlowTracker.getVolumeImbalance(tokenId, now, 90 * 1000);
        volumeImbalanceCache = vi ? vi.imbalance : null;
      }
      return volumeImbalanceCache;
    };

    for (const level of LEVELS) {
      const stateKey = `${level.id}:${market.eventSlug}:${side}`;
      const priceOk = this.checkLevelPriceCondition(level, price, stateKey);
      if (!priceOk) continue;

      for (const windowSec of WINDOWS_SEC) {
        if (secToClose > windowSec) continue;

        for (const pctThreshold of THRESHOLDS) {
          const passesMove = side === "Up" ? pctMove >= pctThreshold : pctMove <= -pctThreshold;
          if (!passesMove) continue;

          this.recordEntryIfNew(level.id, pctThreshold, windowSec, market, side, price, now, getVolumeImbalanceLazy());
        }
      }
    }
  }

  async checkResolutions(): Promise<void> {
    const now = Date.now();
    const toCheck: string[] = [];

    for (const [slug, info] of this.pendingResolution) {
      if (now - info.closeTimeMs >= RESOLVE_CHECK_DELAY_SEC * 1000) {
        toCheck.push(slug);
      }
    }

    for (const slug of toCheck) {
      try {
        const resp = await fetch(`${GAMMA_HOST}/events/slug/${slug}`);
        if (!resp.ok) continue;
        const event = await resp.json();
        const market = (event.markets ?? [])[0];
        if (!market) continue;

        let outcomes: string[];
        let outcomePrices: string[];
        try {
          outcomes = JSON.parse(market.outcomes ?? "[]");
          outcomePrices = JSON.parse(market.outcomePrices ?? "[]");
        } catch {
          continue;
        }
        if (outcomes.length !== 2 || outcomePrices.length !== 2) continue;

        const upIdx = outcomes.findIndex((o) => /^up$/i.test(o.trim()));
        const downIdx = outcomes.findIndex((o) => /^down$/i.test(o.trim()));
        if (upIdx === -1 || downIdx === -1) continue;

        const upPrice = Number(outcomePrices[upIdx]);
        const downPrice = Number(outcomePrices[downIdx]);
        if (upPrice > 0.05 && upPrice < 0.95) continue;

        const winner: "Up" | "Down" = upPrice > downPrice ? "Up" : "Down";

        for (const t of this.tradesList) {
          if (t.eventSlug === slug && !t.determined) {
            t.determined = true;
            t.won = t.side === winner;
          }
        }

        this.pendingResolution.delete(slug);
        this.saveState();
      } catch (err) {
        console.error(`[resolve] ошибка проверки ${slug}:`, (err as Error).message);
      }
    }
  }

  private gridForCoinAndLevel(coin: string, levelId: string): Map<string, { win: number; total: number }> {
    const grid = new Map<string, { win: number; total: number }>();
    for (const param of THRESHOLDS) {
      for (const windowSec of WINDOWS_SEC) {
        grid.set(`${param}_${windowSec}`, { win: 0, total: 0 });
      }
    }
    for (const t of this.tradesList) {
      if (t.coin !== coin || !t.determined || t.levelId !== levelId) continue;
      const key = `${t.pctThreshold}_${t.windowSec}`;
      const s = grid.get(key);
      if (!s) continue;
      s.total++;
      if (t.won) s.win++;
    }
    return grid;
  }

  buildCompactReport(): string {
    const lines: string[] = [];
    lines.push(`<b>📊 Отчёт [УРОВНИ]: ${LEVELS.map((l) => `${l.id} "${l.name}"`).join(", ")}</b>`);
    lines.push(`Уникальных рынков: ${this.marketsSeen.size} | Всего сделок по уровням: ${this.tradesList.length}`);
    lines.push("");

    for (const level of LEVELS) {
      lines.push(`<b>━━━ ${level.id}: ${level.name} ━━━</b>`);
      for (const coin of INCLUDED_COINS) {
        const grid = this.gridForCoinAndLevel(coin, level.id);
        const entries = [...grid.entries()]
          .map(([key, s]) => {
            const [pctStr, winStr] = key.split("_");
            return {
              param: Number(pctStr),
              windowSec: Number(winStr),
              win: s.win,
              total: s.total,
              winRate: s.total > 0 ? s.win / s.total : 0,
            };
          })
          .filter((e) => e.total >= MIN_TRADES_FOR_TOP)
          .sort((a, b) => b.winRate - a.winRate || b.total - a.total)
          .slice(0, 3);

        if (entries.length === 0) continue; // не засоряем отчёт монетами без данных по этому уровню
        lines.push(`  <b>${coin}</b>:`);
        entries.forEach((e, i) => {
          lines.push(`    ${i + 1}. ${thresholdLabel(e.param)} / ${e.windowSec}с — ${(e.winRate * 100).toFixed(0)}% (${e.win}/${e.total})`);
        });
      }
      lines.push("");
    }

    lines.push(`Полная таблица по каждому уровню: "${FULL_GRID_TRIGGERS[0]}" | Разрез по объёму: "${VOLUME_GATE_REPORT_TRIGGERS[0]}"`);
    return lines.join("\n");
  }

  buildFullGridReport(): string {
    const lines: string[] = [];
    lines.push("<b>📊 Полная таблица [УРОВНИ]</b>");
    lines.push("");

    for (const level of LEVELS) {
      lines.push(`<b>━━━ ${level.id}: ${level.name} ━━━</b>`);
      for (const coin of INCLUDED_COINS) {
        const grid = this.gridForCoinAndLevel(coin, level.id);
        const hasAny = [...grid.values()].some((s) => s.total > 0);
        if (!hasAny) continue;

        lines.push(`<b>${coin}</b>`);
        const header = "Порог\\Окно  " + WINDOWS_SEC.map((w) => `${w}с`.padEnd(11)).join("");
        lines.push(`<pre>${header}</pre>`);
        for (const param of THRESHOLDS) {
          const cells = WINDOWS_SEC.map((windowSec) => {
            const s = grid.get(`${param}_${windowSec}`)!;
            const cell = s.total > 0 ? `${s.win}/${s.total} ${(100 * s.win / s.total).toFixed(0)}%` : "—";
            return cell.padEnd(11);
          }).join("");
          lines.push(`<pre>${thresholdLabel(param).padEnd(11)}${cells}</pre>`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /** Idea 8 — разрез винрейта каждого уровня по силе дисбаланса объёма (окно 90с). Дедуп по рынку внутри уровня. */
  buildVolumeGateReport(): string {
    const lines: string[] = [];
    lines.push("<b>📊 Отчёт: разрез по объёму (idea 8) — винрейт уровня при сильном/слабом перекосе объёма</b>");
    lines.push("");

    const BAR = 0.3; // считаем перекос "сильным", если |imbalance| в сторону нашей стороны ≥ этого значения

    for (const level of LEVELS) {
      lines.push(`<b>━━━ ${level.id}: ${level.name} ━━━</b>`);

      const seen = new Map<string, LevelTradeEvent>();
      for (const t of this.tradesList) {
        if (t.levelId !== level.id || !t.determined || t.volumeImbalance90s === null) continue;
        const dedupeKey = `${t.eventSlug}:${t.side}`;
        const existing = seen.get(dedupeKey);
        if (!existing || t.entryTimestamp < existing.entryTimestamp) seen.set(dedupeKey, t);
      }

      const strong = { win: 0, total: 0 };
      const weak = { win: 0, total: 0 };
      for (const t of seen.values()) {
        const imb = t.volumeImbalance90s as number;
        const bucket = imb >= BAR ? strong : weak;
        bucket.total++;
        if (t.won) bucket.win++;
      }

      if (strong.total === 0 && weak.total === 0) {
        lines.push("  пока недостаточно данных");
      } else {
        if (strong.total > 0) {
          lines.push(`  Сильный перекос объёма (≥${(BAR * 100).toFixed(0)}%): ${strong.win}/${strong.total} — ${(100 * strong.win / strong.total).toFixed(0)}%`);
        } else {
          lines.push("  Сильный перекос объёма: пока нет данных");
        }
        if (weak.total > 0) {
          lines.push(`  Слабый/нет перекоса: ${weak.win}/${weak.total} — ${(100 * weak.win / weak.total).toFixed(0)}%`);
        } else {
          lines.push("  Слабый/нет перекоса: пока нет данных");
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  start(): void {
    this.loadState();
    this.refreshMarkets();
    setInterval(() => this.refreshMarkets(), MARKET_REFRESH_MS);
    setInterval(() => this.checkResolutions(), 30 * 1000);
    setInterval(() => {
      console.log(`--- статус (уровни): апдейтов ${this.updateCount}, сделок ${this.tradesList.length} ---`);
    }, 60 * 1000);
    setInterval(() => this.saveState(), AUTOSAVE_INTERVAL_MS);
  }
}

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
  header: string,
  report: string,
): Promise<void> {
  const chunks = splitReportIntoChunks(report);
  for (let i = 0; i < chunks.length; i++) {
    const partLabel = chunks.length > 1 ? ` (часть ${i + 1}/${chunks.length})` : "";
    const text = i === 0 ? `${header}${partLabel}\n\n${chunks[i]}` : `<b>...продолжение${partLabel}</b>\n\n${chunks[i]}`;
    try {
      await telegram?.send(text);
    } catch (err) {
      console.error(`[sendReportToTelegram] ошибка отправки части ${i + 1}/${chunks.length}:`, (err as Error).message);
    }
  }
}

/**
 * Проверяет текст на все триггеры research-grid-levels.ts (уровни/полная/
 * объемгейт) и возвращает готовый отчёт, если что-то совпало, либо null.
 * Экспортируется для переиспользования в research-combined.ts.
 */
export function tryHandleLevelsCommand(
  rawText: string,
  research: LevelsResearchLogger,
): { header: string; report: string } | null {
  const text = rawText.toLowerCase();

  if (FULL_GRID_TRIGGERS.some((p) => text.includes(p.toLowerCase()))) {
    return { header: "<b>📊 Полная таблица уровней по запросу</b>", report: research.buildFullGridReport() };
  }
  if (VOLUME_GATE_REPORT_TRIGGERS.some((p) => text.includes(p.toLowerCase()))) {
    return { header: "<b>📊 Разрез по объёму по запросу</b>", report: research.buildVolumeGateReport() };
  }
  if (COMPACT_REPORT_TRIGGERS.some((p) => text.includes(p.toLowerCase()))) {
    return { header: "<b>📊 Отчёт по уровням по запросу</b>", report: research.buildCompactReport() };
  }
  return null;
}

async function pollTelegramCommands(
  botToken: string,
  chatId: string,
  telegram: ReturnType<typeof createTelegramNotifier>,
  research: LevelsResearchLogger,
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

        const result = tryHandleLevelsCommand(msg.text, research);
        if (result) {
          console.log(`[telegram] Запрос (уровни): "${msg.text}"`);
          await sendReportToTelegram(telegram, result.header, result.report);
        }
      }
    } catch (err) {
      console.error("[telegram poll] ошибка:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  console.log("Исследовательский логгер УРОВНИ запущен (отдельный процесс, своё состояние, ничего не торгует).");
  console.log("Уровни:", LEVELS.map((l) => `${l.id}="${l.name}"`).join(", "));
  console.log("Пороги (%):", THRESHOLDS.map(thresholdLabel).join(", "));
  console.log("Окна входа (с):", WINDOWS_SEC.join(", "));

  btcPriceFeed.start();
  ethPriceFeed.start();
  solPriceFeed.start();
  xrpPriceFeed.start();
  dogePriceFeed.start();
  tradeFlowTracker.start();

  const logger = createLogger(false);
  const telegram = createTelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, logger);

  const research = new LevelsResearchLogger();
  research.start();

  if (telegram && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    console.log(
      `Telegram включён — "${COMPACT_REPORT_TRIGGERS[0]}" (кратко по уровням), "${FULL_GRID_TRIGGERS[0]}" (полная таблица), ` +
        `"${VOLUME_GATE_REPORT_TRIGGERS[0]}" (разрез по объёму).`,
    );
    pollTelegramCommands(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, telegram, research);

    console.log(`Автоотчёт (краткий) включён — каждые ${AUTO_REPORT_INTERVAL_MS / 60000} минут.`);
    setInterval(async () => {
      try {
        await sendReportToTelegram(telegram, "<b>⏰ Автоотчёт по уровням (каждые 30 мин)</b>", research.buildCompactReport());
      } catch (err) {
        console.error("[autoReport] ошибка отправки:", (err as Error).message);
      }
    }, AUTO_REPORT_INTERVAL_MS);
  } else {
    console.log("Telegram не настроен — отчёт будет только в консоли.");
  }

  const sendFinal = async () => {
    console.log("\n" + research.buildCompactReport());
    research.saveState();
    if (telegram) {
      await sendReportToTelegram(telegram, "<b>🌙 Финальный отчёт за ночь (уровни)</b>", research.buildCompactReport());
    }
    process.exit(0);
  };

  process.on("SIGINT", sendFinal);
  process.on("SIGTERM", sendFinal);
}

// Автозапуск ТОЛЬКО при прямом запуске файла, не при импорте из research-combined.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Фатальная ошибка:", err);
    process.exit(1);
  });
}
