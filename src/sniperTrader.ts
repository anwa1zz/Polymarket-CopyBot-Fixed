/**
 * Этап 3: та же логика, что в snipeWatcher.ts (Этап 2), но теперь при
 * срабатывании реально выставляется GTC-лимитка на покупку лидирующей
 * стороны по цене 0.999 — и остаётся висеть в стакане без таймаута,
 * пока не исполнится (сколько наберёт) или пока рынок не будет
 * зарезолвлен и мы её не отменим вручную позже (это будет Этап 4).
 *
 * ПО УМОЛЧАНИЮ РЕЖИМ DRY_RUN=true — реальные ордера НЕ выставляются,
 * только печатается, что бы бот сделал. Чтобы включить реальную торговлю,
 * нужно явно задать переменную окружения SNIPER_DRY_RUN=false.
 *
 * Размер сделки берётся из SNIPER_TRADE_SIZE_USD (по умолчанию $10 —
 * маленькая тестовая сумма для проверки, что всё работает end-to-end).
 */
console.log(`🔧 Node.js версия: ${process.version}`);
import "dotenv/config";
import { Side } from "@polymarket/clob-client-v2";
import { discoverCryptoUpDownMarkets, CryptoUpDownMarket } from "./cryptoMarketDiscovery.js";
import { PriceWatcher, PriceUpdate } from "./priceWatcher.js";
import { ClobService } from "./clob.js";
import { RedeemService } from "./redeem.js";
import { DataApiClient } from "./dataApi.js";
import { createLogger } from "./logger.js";

const DRY_RUN = (process.env.SNIPER_DRY_RUN ?? "true").toLowerCase() !== "false";
const AUTO_REDEEM = (process.env.SNIPER_AUTO_REDEEM ?? "true").toLowerCase() !== "false";
const REDEEM_POLL_MS = 60 * 1000;
const TRADE_SIZE_USD = Number(process.env.SNIPER_TRADE_SIZE_USD ?? "10");
const ENTRY_PRICE = 0.999;
// Порог входа — ставим ТОЛЬКО если к моменту T-N секунд цена лидирующей
// стороны уже реально дошла до 0.99. Если ни одна сторона не дошла —
// в этом раунде просто ничего не покупаем, ждём следующий рынок.
const MIN_ENTRY_PRICE = Number(process.env.SNIPER_MIN_ENTRY_PRICE ?? "0.99");
const TRIGGER_SECONDS_BEFORE_CLOSE = Number(process.env.SNIPE_TRIGGER_SEC ?? "5");
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

class SniperTrader {
  private watcher: PriceWatcher | null = null;
  private tokenIndex = new Map<string, TokenInfo>();
  private alreadyFired = new Set<string>();
  private lastTokenIds: string[] = [];
  private updateCount = 0;
  private lastPrice = new Map<string, { up: number | null; down: number | null }>();

  constructor(private clob: ClobService | null) {}

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
      `[refresh] всего рынков: ${allMarkets.length}, закрываются в ближайшие 3 мин: ${markets.length} (${tokenIds.length} токенов), сработало снайпов: ${this.alreadyFired.size}`,
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

    if (this.alreadyFired.has(market.eventSlug)) return;

    const secToClose = (market.closeTimeMs - Date.now()) / 1000;
    if (secToClose > TRIGGER_SECONDS_BEFORE_CLOSE || secToClose < -STALE_AFTER_CLOSE_SEC) return;

    const { up, down } = entry;
    if (up === null && down === null) return;

    const leaderSide: "Up" | "Down" = (up ?? -1) >= (down ?? -1) ? "Up" : "Down";
    const leaderPrice = leaderSide === "Up" ? up : down;

    // Не покупаем "как получится" — только если реально дошло до 0.99.
    // Иначе просто пропускаем этот рынок (не наш случай в этот раз).
    if (leaderPrice === null || leaderPrice < MIN_ENTRY_PRICE) {
      // Печатаем ТОЛЬКО последний тик перед самым закрытием (secToClose
      // в районе 0), чтобы не спамить — но видно было, какая цена была
      // на самом деле у монет, которые бот пропустил.
      if (secToClose <= 1) {
        console.log(
          `   [пропущено] [${market.coin}/${market.windowMinutes}м]: Up=${up} Down=${down} — порог ${MIN_ENTRY_PRICE} не пройден`,
        );
      }
      return;
    }

    const leaderTokenId = leaderSide === "Up" ? market.upTokenId : market.downTokenId;

    this.alreadyFired.add(market.eventSlug);
    this.executeSnipe(market, leaderSide, leaderTokenId, leaderPrice, secToClose);
  }

  private async executeSnipe(
    market: CryptoUpDownMarket,
    side: "Up" | "Down",
    tokenId: string,
    currentPrice: number | null,
    secToClose: number,
  ): Promise<void> {
    const size = TRADE_SIZE_USD / ENTRY_PRICE;

    console.log(
      `\n🎯 СНАЙП: [${market.coin} / ${market.windowMinutes}мин] "${market.title}"\n` +
        `   Сторона: ${side} | Текущая цена: ~${currentPrice} | Наша заявка: ${size.toFixed(2)} акций по ${ENTRY_PRICE} (~$${TRADE_SIZE_USD}) | До закрытия: ${secToClose.toFixed(1)}с`,
    );

    if (DRY_RUN || !this.clob) {
      console.log(`   [DRY RUN] Ордер НЕ отправлен. eventSlug: ${market.eventSlug}`);
      return;
    }

    try {
      const result = await this.clob.placeGtcLimitOrder({
        tokenId,
        side: Side.BUY,
        price: ENTRY_PRICE,
        size,
        offsetPct: 0, // без сдвига — ставим ровно по 0.999
      });
      console.log(
        `   ✅ ОРДЕР ВЫСТАВЛЕН: orderId=${result.orderId ?? "?"} status=${result.status} filled=${result.filledSize ?? "0"}`,
      );
    } catch (err) {
      console.error(`   ❌ ОШИБКА РАЗМЕЩЕНИЯ ОРДЕРА:`, (err as Error).message);
    }
  }

  start(): void {
    this.refreshMarkets();
    setInterval(() => this.refreshMarkets(), MARKET_REFRESH_MS);
    setInterval(() => {
      console.log(
        `--- статус: обновлений цены получено ${this.updateCount}, сработало снайпов ${this.alreadyFired.size} ---`,
      );
    }, 30 * 1000);
  }
}

async function redeemLoop(): Promise<void> {
  const rpcUrl = process.env.RPC_URL;
  const profileAddress = process.env.PROFILE_ADDRESS ?? process.env.FUNDER_ADDRESS;

  if (!rpcUrl || !profileAddress) {
    console.warn(
      "[redeem] AUTO_REDEEM включён, но RPC_URL или PROFILE_ADDRESS не заданы в .env — авто-клейм выигрышей отключён.",
    );
    return;
  }

  const logger = createLogger(false);
  const dataApi = new DataApiClient(
    process.env.DATA_API_HOST ?? "https://data-api.polymarket.com",
    logger,
  );

  const apiKey = process.env.BUILDER_API_KEY;
  const apiSecret = process.env.BUILDER_API_SECRET;
  const apiPassphrase = process.env.BUILDER_API_PASSPHRASE;
  const builderCreds =
    apiKey && apiSecret && apiPassphrase
      ? { key: apiKey, secret: apiSecret, passphrase: apiPassphrase }
      : undefined;

  const redeemService = RedeemService.init(
    {
      relayerUrl: process.env.RELAYER_URL ?? "https://relayer-v2.polymarket.com",
      chainId: Number(process.env.CHAIN_ID ?? "137"),
      privateKey: process.env.PRIVATE_KEY!,
      rpcUrl,
      txType: (process.env.RELAYER_TX_TYPE as "SAFE" | "PROXY") ?? "PROXY",
      builderCreds,
    },
    logger,
  );

  console.log("[redeem] Авто-клейм выигрышей запущен, проверка раз в минуту.");

  const attempted = new Set<string>();

  for (;;) {
    try {
      const positions = await dataApi.getPositions(profileAddress, true);
      const eligible = positions.filter((p) => !attempted.has(p.conditionId));

      if (eligible.length > 0) {
        console.log(`[redeem] Найдено выигрышных позиций к клейму: ${eligible.length}`);
        const txHashes = await redeemService.redeemPositions(eligible);
        for (const p of eligible) attempted.add(p.conditionId);
        if (txHashes.length > 0) {
          console.log(`[redeem] ✅ Заклеймлено транзакций: ${txHashes.length} —`, txHashes);
        }
      }
    } catch (err) {
      console.error("[redeem] ошибка:", (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, REDEEM_POLL_MS));
  }
}

async function main() {
  console.log(`Режим: ${DRY_RUN ? "DRY_RUN (без реальных сделок)" : "⚠️  LIVE — РЕАЛЬНЫЕ ДЕНЬГИ"}`);
  console.log(`Размер тестовой сделки: $${TRADE_SIZE_USD}, цена входа: ${ENTRY_PRICE}, порог входа: ${MIN_ENTRY_PRICE}, триггер: T-${TRIGGER_SECONDS_BEFORE_CLOSE}с`);

  let clob: ClobService | null = null;
  if (!DRY_RUN) {
    const logger = createLogger(false);

    // Как и в рабочем боте: если в .env уже лежат готовые API-ключи —
    // используем их напрямую, а не выводим заново (вывод "на лету" без
    // signatureType у временного клиента даёт несовпадение адреса
    // подписанта при signatureType=3/deposit wallet).
    const apiKey = process.env.CLOB_API_KEY;
    const apiSecret = process.env.CLOB_API_SECRET;
    const apiPassphrase = process.env.CLOB_API_PASSPHRASE;
    const apiCreds =
      apiKey && apiSecret && apiPassphrase
        ? { key: apiKey, secret: apiSecret, passphrase: apiPassphrase }
        : undefined;

    clob = await ClobService.init(
      {
        host: process.env.CLOB_HOST ?? "https://clob.polymarket.com",
        rpcUrl: process.env.RPC_URL,
        chainId: Number(process.env.CHAIN_ID ?? "137"),
        privateKey: process.env.PRIVATE_KEY!,
        signatureType: Number(process.env.SIGNATURE_TYPE ?? "1"),
        funderAddress: process.env.FUNDER_ADDRESS ?? process.env.PROFILE_ADDRESS,
        apiCreds,
      },
      logger,
    );
    console.log(
      apiCreds
        ? "ClobService инициализирован для LIVE торговли (готовые API-ключи из .env)."
        : "ClobService инициализирован для LIVE торговли (ключи выведены заново — если получишь 'signer address' ошибку, добавь CLOB_API_KEY/SECRET/PASSPHRASE в .env из старого бота).",
    );
  }

  const trader = new SniperTrader(clob);
  trader.start();

  if (!DRY_RUN && AUTO_REDEEM) {
    redeemLoop(); // работает параллельно, не блокирует снайпер
  }
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
  process.exit(1);
});