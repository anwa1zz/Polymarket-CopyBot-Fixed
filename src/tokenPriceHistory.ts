/**
 * Модуль: короткая история цены САМОГО ТОКЕНА (ставки Up/Down на Polymarket),
 * в отличие от volatilityTracker.ts, который следит за ценой МОНЕТЫ (BTC и т.д.).
 *
 * Нужен для idea-групп, где важно не "что с монетой", а "что с самим рынком
 * ставок прямо сейчас": скорость подлёта к уровню, спред Up/Down, скользящая
 * средняя цены токена, асимметрия скорости Up vs Down, частота обновлений
 * как грубая прокси-метрика активности (НЕ точное число сделок — точное число
 * сделок потребовало бы доступа к внутренностям tradeFlowTracker.ts, которых
 * у нас нет, поэтому здесь считаем количество ОБНОВЛЕНИЙ ОРДЕРБУКА за
 * последние секунды — это коррелирует с активностью, но не тождественно ей).
 *
 * Питается напрямую из тех же апдейтов PriceWatcher, что и остальная логика —
 * НЕ открывает собственное соединение, просто вызывающий код обязан дёргать
 * recordUpdate() на каждый апдейт цены токена.
 */

interface Sample {
  ts: number;
  price: number;
}

const BUFFER_MS = 3 * 60 * 1000; // 3 минуты истории на токен — с запасом под все метрики ниже

export class TokenPriceHistory {
  private buffers = new Map<string, Sample[]>();

  /** Вызывать на КАЖДЫЙ апдейт цены токена (bestBid/bestAsk), не только на потенциальный вход. */
  recordUpdate(tokenId: string, price: number, ts: number = Date.now()): void {
    let buf = this.buffers.get(tokenId);
    if (!buf) {
      buf = [];
      this.buffers.set(tokenId, buf);
    }
    buf.push({ ts, price });
    const cutoff = ts - BUFFER_MS;
    while (buf.length && buf[0].ts < cutoff) buf.shift();
  }

  /** Убрать буфер токена, который больше не наблюдается (рынок закрылся) — чистим память. */
  forget(tokenId: string): void {
    this.buffers.delete(tokenId);
  }

  private closestSample(tokenId: string, ts: number): Sample | null {
    const buf = this.buffers.get(tokenId);
    if (!buf || buf.length === 0) return null;
    let closest = buf[0];
    for (const s of buf) {
      if (Math.abs(s.ts - ts) < Math.abs(closest.ts - ts)) closest = s;
      if (s.ts > ts) break;
    }
    return closest;
  }

  getPriceAt(tokenId: string, ts: number): number | null {
    return this.closestSample(tokenId, ts)?.price ?? null;
  }

  getLatestPrice(tokenId: string): number | null {
    const buf = this.buffers.get(tokenId);
    return buf && buf.length ? buf[buf.length - 1].price : null;
  }

  /** Максимальная цена токена за окно [endMs-windowMs, endMs] — нужно для idea 1 и 6 (был ли пик у уровня). */
  getMaxOverWindow(tokenId: string, endMs: number, windowMs: number): number | null {
    const buf = this.buffers.get(tokenId);
    if (!buf || buf.length === 0) return null;
    const startMs = endMs - windowMs;
    let max: number | null = null;
    for (const s of buf) {
      if (s.ts < startMs || s.ts > endMs) continue;
      if (max === null || s.price > max) max = s.price;
    }
    return max;
  }

  /** Знаковое (не по модулю!) изменение цены за окно — нужно для асимметрии Up/Down (idea 12). */
  getSignedMoveOverWindow(tokenId: string, endMs: number, windowMs: number): number | null {
    const end = this.getPriceAt(tokenId, endMs);
    const start = this.getPriceAt(tokenId, endMs - windowMs);
    if (end === null || start === null) return null;
    return end - start;
  }

  /** Простая скользящая средняя цены токена за окно, заканчивающееся в atMs. */
  getMovingAverage(tokenId: string, atMs: number, windowMs: number): number | null {
    const buf = this.buffers.get(tokenId);
    if (!buf || buf.length === 0) return null;
    const startMs = atMs - windowMs;
    const inWindow = buf.filter((s) => s.ts >= startMs && s.ts <= atMs);
    if (inWindow.length === 0) return null;
    return inWindow.reduce((sum, s) => sum + s.price, 0) / inWindow.length;
  }

  /** Грубая прокси-метрика активности: сколько апдейтов ордербука было за последние windowMs. НЕ точное число сделок. */
  getUpdateCount(tokenId: string, atMs: number, windowMs: number): number {
    const buf = this.buffers.get(tokenId);
    if (!buf || buf.length === 0) return 0;
    const startMs = atMs - windowMs;
    return buf.filter((s) => s.ts >= startMs && s.ts <= atMs).length;
  }
}

export const tokenPriceHistory = new TokenPriceHistory();
