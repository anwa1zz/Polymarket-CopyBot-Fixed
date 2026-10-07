/**
 * Модуль: скользящий трекер волатильности монет (realized vol).
 * Используется ТОЛЬКО в research-grid.ts (не в боевом fastFlip.ts) —
 * это инструмент измерения, не торговли.
 *
 * Идея: вместо того чтобы гадать фиксированный порог движения на монету
 * (0.13%, 0.5% и т.д.), меряем, каким ОБЫЧНО бывает 5-минутное движение
 * этой монеты за последний час, и задаём порог как долю от этого
 * значения (multiplier × recentVol). В тихий рынок recentVol падает,
 * порог сам подстраивается ниже — и наоборот.
 *
 * recentVol = среднее АБСОЛЮТНОЕ 5-минутное движение цены монеты
 * (Chainlink TWAP через те же фиды, что в fastFlip/research-grid),
 * усреднённое по перекрывающимся окнам за последний час.
 *
 * Отдельно даёт getMoveOverWindow() — сырую величину движения за
 * произвольное окно, нужна и для recentVol, и для отдельного пассивного
 * замера "замедления тейпа" (tick deceleration) в research-grid.ts.
 */

interface Sample {
  ts: number;
  price: number;
}

const SAMPLE_INTERVAL_MS = 15 * 1000; // частота сэмплирования цены на монету
const LOOKBACK_MS = 60 * 60 * 1000; // держим час истории для расчёта vol
const MOVE_HORIZON_MS = 5 * 60 * 1000; // "типичное движение" меряем на горизонте 5 минут (= длина торгового окна)

interface CoinPriceFeed {
  getLatestPrice(): number | null;
}

export class VolatilityTracker {
  private feeds: Record<string, CoinPriceFeed>;
  private buffers = new Map<string, Sample[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(feeds: Record<string, CoinPriceFeed>) {
    this.feeds = feeds;
    for (const coin of Object.keys(feeds)) this.buffers.set(coin, []);
  }

  start(): void {
    this.sampleAll();
    this.timer = setInterval(() => this.sampleAll(), SAMPLE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private sampleAll(): void {
    const now = Date.now();
    for (const [coin, feed] of Object.entries(this.feeds)) {
      const price = feed.getLatestPrice();
      if (price === null) continue;
      const buf = this.buffers.get(coin)!;
      buf.push({ ts: now, price });
      const cutoff = now - LOOKBACK_MS;
      while (buf.length && buf[0].ts < cutoff) buf.shift();
    }
  }

  /** Ближайший по времени сэмпл к ts (буфер монотонный по ts, поиск с ранним break). */
  private closestSample(coin: string, ts: number): Sample | null {
    const buf = this.buffers.get(coin);
    if (!buf || buf.length === 0) return null;
    let closest = buf[0];
    for (const s of buf) {
      if (Math.abs(s.ts - ts) < Math.abs(closest.ts - ts)) closest = s;
      if (s.ts > ts) break;
    }
    return closest;
  }

  /**
   * Абсолютное % движение цены монеты за windowMs, заканчивающееся в endMs.
   * null — если буфер ещё не накопил историю на нужную глубину (тогда
   * "ближайший" сэмпл был бы слишком далеко от реального startMs и дал бы
   * ложное значение).
   */
  getMoveOverWindow(coin: string, endMs: number, windowMs: number): number | null {
    const buf = this.buffers.get(coin);
    if (!buf || buf.length === 0) return null;
    const startMs = endMs - windowMs;
    if (buf[0].ts > startMs + SAMPLE_INTERVAL_MS * 2) return null;
    const endSample = this.closestSample(coin, endMs);
    const startSample = this.closestSample(coin, startMs);
    if (!endSample || !startSample || startSample.price === 0) return null;
    return Math.abs((endSample.price - startSample.price) / startSample.price);
  }

  /**
   * "Типичная" величина 5-минутного движения за последний час — среднее
   * по перекрывающимся окнам (каждый сэмпл как конец своего 5-минутного
   * окна). Это и есть recentVol, от которого считается адаптивный порог.
   * null — пока не накопили час истории (возвращаем честно, а не
   * приблизительное значение на неполных данных).
   */
  getRecentVolatility(coin: string, atMs: number = Date.now()): number | null {
    const buf = this.buffers.get(coin);
    if (!buf || buf.length < 3) return null;
    const earliestNeeded = atMs - LOOKBACK_MS;
    if (buf[0].ts > earliestNeeded + MOVE_HORIZON_MS) return null;

    const moves: number[] = [];
    for (const s of buf) {
      if (s.ts > atMs) break;
      if (s.ts - MOVE_HORIZON_MS < buf[0].ts) continue;
      const move = this.getMoveOverWindow(coin, s.ts, MOVE_HORIZON_MS);
      if (move !== null) moves.push(move);
    }
    if (moves.length === 0) return null;
    return moves.reduce((a, b) => a + b, 0) / moves.length;
  }
}
