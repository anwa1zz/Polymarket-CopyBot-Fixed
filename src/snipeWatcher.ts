/**
 * Модуль 2: следим за ценой рынков, которые вот-вот закроются. За
 * TRIGGER_SECONDS_BEFORE_CLOSE секунд до закрытия проверяем — дошла ли
 * цена лидирующей стороны до MIN_ENTRY_PRICE (0.99). Если да — это и есть
 * снайп-кандидат (в реальном боте тут встанет лимитка на покупку по
 * 0.999). Если ни одна сторона не дошла до 0.99 — рынок просто
 * пропускаем, ничего не покупаем.
 *
 * ЭТО ДРАЙ-РАН: реальные ордера здесь НЕ выставляются, только логирование.
 */

import { discoverCryptoUpDownMarkets, CryptoUpDownMarket } from "./cryptoMarketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";

const TRIGGER_SECONDS_BEFORE_CLOSE = Number(process.env.SNIPE_TRIGGER_SEC ?? "5");
const MIN_ENTRY_PRICE = Number(process.env.SNIPER_MIN_ENTRY_PRICE ?? "0.99");
const MARKET_REFRESH_MS = 30 * 1000;
const CLOSE_SOON_WINDOW_MS = 3 * 60 * 1000;
const STALE_AFTER_CLOSE_SEC = 30;

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

class SnipeWatcher {
  private watcher: PriceWatcher | null = null;
  private tokenIndex = new Map<string, TokenInfo>();
  private alreadyLogged = new Set<string>();
  private lastTokenIds: string[] = [];
  private updateCount = 0;
  private lastPrice = new Map<string, { up: number | null; down: number | null }>();

  async refreshMarkets(): Promise<void> {
    let allMarkets: CryptoUpDownMarket[];
    try {
      allMarkets = await discoverCryptoUpDownMarkets();
    } catch (err) {
      console.error("[refresh] ошибка получения списка рынков:", (err as Error).message);
      return;
    }

    const now = Date.now();
    const markets = allMarkets.filter((m) => m.closeTimeMs - now <= CLOSE_SOON_WINDOW_MS);

    this.tokenIndex = buildTokenIndex(markets);
    const tokenIds = [...this.tokenIndex.keys()].sort();

    console.log(
      `[refresh] всего рынков: ${allMarkets.length}, закрываются в ближайшие 3 мин: ${markets.length} (${tokenIds.length} токенов), сработало снайпов: ${this.alreadyLogged.size}`,
    );

    const sameAsLastTime =
      tokenIds.length === this.lastTokenIds.length &&
      tokenIds.every((id, i) => id === this.lastTokenIds[i]);
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

  private onPriceUpdate(update: PriceUpdate): void {
    this.updateCount++;
    const info = this.tokenIndex.get(update.tokenId);
    if (!info) return;
    const { market, side } = info;

    const price = update.bestBid ?? update.bestAsk;
    const entry = this.lastPrice.get(market.eventSlug) ?? { up: null, down: null };
    if (side === "Up") entry.up = price ?? entry.up;
    else entry.down = price ?? entry.down;
    this.lastPrice.set(market.eventSlug, entry);

    if (this.alreadyLogged.has(market.eventSlug)) return;

    const secToClose = (market.closeTimeMs - Date.now()) / 1000;
    if (secToClose > TRIGGER_SECONDS_BEFORE_CLOSE || secToClose < -STALE_AFTER_CLOSE_SEC) return;

    const { up, down } = entry;
    if (up === null && down === null) return;

    const leaderSide: "Up" | "Down" = (up ?? -1) >= (down ?? -1) ? "Up" : "Down";
    const leaderPrice = leaderSide === "Up" ? up : down;

    // Не считаем кандидатом, если цена ещё не дошла до порога — просто
    // ждём следующий апдейт (в пределах того же окна T-N..закрытие).
    if (leaderPrice === null || leaderPrice < MIN_ENTRY_PRICE) return;

    this.alreadyLogged.add(market.eventSlug);
    console.log(
      `\n🎯 СНАЙП: [${market.coin} / ${market.windowMinutes}мин] "${market.title}"\n` +
        `   Ставим на: ${leaderSide} (цена сейчас ~${leaderPrice}) | Up=${up} Down=${down} | До закрытия: ${secToClose.toFixed(1)}с | eventSlug: ${market.eventSlug}\n`,
    );
  }

  start(): void {
    this.refreshMarkets();
    setInterval(() => this.refreshMarkets(), MARKET_REFRESH_MS);
    setInterval(() => {
      console.log(
        `--- статус: обновлений цены получено ${this.updateCount}, сработало снайпов ${this.alreadyLogged.size} ---`,
      );
    }, 30 * 1000);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(
    `Запуск в режиме наблюдения (DRY RUN, без ордеров). Порог входа: ${MIN_ENTRY_PRICE}, триггер: T-${TRIGGER_SECONDS_BEFORE_CLOSE}с до закрытия.`,
  );
  const watcher = new SnipeWatcher();
  watcher.start();
}