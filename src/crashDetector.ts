/**
 * Модуль 3: детектор резкого движения цены.
 * Держит историю цены каждого токена за последние N секунд,
 * выдаёт сигнал ОДИН РАЗ, когда цена резко падает мимо порога (не спамит повторно).
 */

import { PriceUpdate } from "./priceWatcher.js";

export interface CrashSignal {
  tokenId: string;
  priceBefore: number;
  priceNow: number;
  changePct: number;
  windowSec: number;
  timestamp: number;
}

interface HistoryPoint {
  price: number;
  timestamp: number;
}

export class CrashDetector {
  private history = new Map<string, HistoryPoint[]>();
  private lastSignalAt = new Map<string, number>();
  private windowMs: number;
  private minDropPct: number;
  private absoluteLowThreshold: number;
  private absoluteHighThreshold: number;
  private cooldownMs: number;

  constructor(opts: {
    windowSec?: number;
    minDropPct?: number;
    absoluteLowThreshold?: number;
    absoluteHighThreshold?: number;
    cooldownSec?: number; // не выдавать сигнал повторно по этому токену раньше, чем через N секунд
  } = {}) {
    this.windowMs = (opts.windowSec ?? 60) * 1000;
    this.minDropPct = opts.minDropPct ?? 10;
    this.absoluteLowThreshold = opts.absoluteLowThreshold ?? 0.90;
    this.absoluteHighThreshold = opts.absoluteHighThreshold ?? 0.20;
    this.cooldownMs = (opts.cooldownSec ?? 300) * 1000; // по умолчанию 5 минут
  }

  onPriceUpdate(update: PriceUpdate): CrashSignal | null {
    // Не мешаем ask и bid — это разные вещи с разных сторон спреда.
// Сравниваем только "ask с ask" и "bid с bid" раздельно, иначе ложные сигналы.
const price = update.bestAsk;
if (price === null) return null;

    const key = update.tokenId;
    const hist = this.history.get(key) ?? [];
    hist.push({ price, timestamp: update.timestamp });

    const cutoff = update.timestamp - this.windowMs;
    const trimmed = hist.filter((h) => h.timestamp >= cutoff);
    this.history.set(key, trimmed);

    if (trimmed.length < 2) return null;

    // проверка кулдауна — не сигналим повторно слишком часто по одному токену
    const lastSignal = this.lastSignalAt.get(key);
    if (lastSignal && update.timestamp - lastSignal < this.cooldownMs) {
      return null;
    }

    const oldest = trimmed[0];
    const changePct = (oldest.price - price) * 100;

    const wasInMidRange = oldest.price <= this.absoluteLowThreshold && oldest.price >= 0.05;
    const droppedBelow = price <= this.absoluteHighThreshold;
    const bigEnoughDrop = changePct >= this.minDropPct;

    if (wasInMidRange && droppedBelow && bigEnoughDrop) {
      this.lastSignalAt.set(key, update.timestamp);
      // очищаем историю по этому токену, чтобы следующее сравнение шло от текущей точки, а не от старой
      this.history.set(key, [{ price, timestamp: update.timestamp }]);

      return {
        tokenId: key,
        priceBefore: oldest.price,
        priceNow: price,
        changePct,
        windowSec: (update.timestamp - oldest.timestamp) / 1000,
        timestamp: update.timestamp,
      };
    }
    return null;
  }
}

// Тестовый запуск: npx tsx src/crashDetector.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.all([
    import("./marketDiscovery.js"),
    import("./priceWatcher.js"),
  ]).then(async ([{ discoverWeatherMarkets }, { PriceWatcher }]) => {
    const markets = await discoverWeatherMarkets();
    const testMarkets = markets.slice(0, 60);
    const tokenIds = testMarkets.flatMap((m) => m.bins.flatMap((b) => [b.yesTokenId, b.noTokenId]));
    console.log(`Мониторим ${testMarkets.length} рынков, ${tokenIds.length} токенов, ищем обвалы...`);

    const detector = new CrashDetector();
    let updateCount = 0;
    let signalCount = 0;

    const watcher = new PriceWatcher(tokenIds, (update) => {
      updateCount++;
      const signal = detector.onPriceUpdate(update);
      if (signal) {
        signalCount++;
        console.log("🚨 ОБВАЛ ОБНАРУЖЕН:", JSON.stringify(signal, null, 2));
      }
    });
    watcher.start();

    setInterval(() => {
      console.log(`--- обновлений: ${updateCount}, сигналов: ${signalCount} ---`);
    }, 15000);
  });
}