/**
 * Трекер реального потока сделок (не цены, а именно исполненных
 * покупок/продаж) на токенах Up/Down через ПУБЛИЧНЫЙ канал Polymarket
 * (авторизация не нужна): wss://ws-subscriptions-clob.polymarket.com/ws/market,
 * событие "last_trade_price".
 *
 * Отличие от priceWatcher.ts: priceWatcher следит за ЦЕНОЙ (лучший бид/аск
 * в стакане), а этот модуль следит за тем, что РЕАЛЬНО купили/продали —
 * каждое сообщение last_trade_price это одна исполненная сделка с полями
 * price, size, side (BUY/SELL — сторона агрессора).
 *
 * Идея: перед входом в сделку посчитать, сколько объёма реально купили,
 * а сколько продали за последние N секунд на конкретном токене (Up или
 * Down) — если идёт активная агрессивная скупка именно той стороны, в
 * которую собираемся войти, это дополнительный сигнал поверх самого
 * факта движения цены монеты.
 *
 * Документация: https://docs.polymarket.com/market-data/realtime-data
 * (раздел "Market Stream" -> "Last Trade Price").
 */

import WebSocket from "ws";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL_MS = 10 * 1000; // документация: слать текстовый "PING" каждые 10с
const RECONNECT_MS = 2000;
const BUFFER_MS = 10 * 60 * 1000; // храним сделки за последние 10 минут на токен — с запасом под окна до 120с

interface TradeRecord {
  ts: number;
  side: "BUY" | "SELL";
  size: number;
}

export interface VolumeImbalance {
  buyVol: number;
  sellVol: number;
  /** (buyVol - sellVol) / (buyVol + sellVol), диапазон -1..1. 0, если сделок не было. */
  imbalance: number;
  tradeCount: number;
}

class TradeFlowTracker {
  private ws: WebSocket | null = null;
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;

  private currentTokenIds: Set<string> = new Set();
  private trades: Map<string, TradeRecord[]> = new Map();

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      console.log("[tradeFlowTracker] подключено к публичному market-каналу Polymarket");
      if (this.currentTokenIds.size > 0) {
        this.ws!.send(
          JSON.stringify({ assets_ids: [...this.currentTokenIds], type: "market" }),
        );
      }
      this.startPing();
    });

    this.ws.on("message", (raw: Buffer) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on("close", () => {
      if (this.stopped) return;
      console.log(`[tradeFlowTracker] соединение закрыто, переподключение через ${RECONNECT_MS}мс`);
      this.stopPing();
      setTimeout(() => this.connect(), RECONNECT_MS);
    });

    this.ws.on("error", (err) => {
      console.error("[tradeFlowTracker] ошибка:", err.message);
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send("PING");
        } catch {
          // проигнорируем
        }
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // например, текстовый "PONG"
    }
    const events = Array.isArray(msg) ? msg : [msg];
    for (const event of events) {
      if (event.event_type !== "last_trade_price") continue;

      const tokenId: string | undefined = event.asset_id;
      const side: string | undefined = event.side;
      const size = Number(event.size);
      const ts = Number(event.timestamp);

      if (!tokenId || (side !== "BUY" && side !== "SELL")) continue;
      if (!Number.isFinite(size) || !Number.isFinite(ts)) continue;

      let list = this.trades.get(tokenId);
      if (!list) {
        list = [];
        this.trades.set(tokenId, list);
      }
      list.push({ ts, side, size });

      const cutoff = Date.now() - BUFFER_MS;
      while (list.length && list[0].ts < cutoff) list.shift();
    }
  }

  /**
   * Обновляет набор отслеживаемых токенов. Использует динамическую
   * подписку/отписку Polymarket (без пересоздания соединения) — как
   * описано в документации market-канала.
   */
  updateTokenIds(tokenIds: string[]): void {
    const next = new Set(tokenIds);

    const toAdd = [...next].filter((id) => !this.currentTokenIds.has(id));
    const toRemove = [...this.currentTokenIds].filter((id) => !next.has(id));

    if (toAdd.length === 0 && toRemove.length === 0) return;

    this.currentTokenIds = next;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return; // применится при следующем connect()

    if (toAdd.length > 0) {
      this.ws.send(JSON.stringify({ assets_ids: toAdd, operation: "subscribe" }));
    }
    if (toRemove.length > 0) {
      this.ws.send(JSON.stringify({ assets_ids: toRemove, operation: "unsubscribe" }));
      for (const id of toRemove) this.trades.delete(id);
    }
  }

  /** Дисбаланс объёма купли/продажи за последние windowMs мс до atTimeMs (включительно). null — если токен не отслеживается вообще. */
  getVolumeImbalance(tokenId: string, atTimeMs: number, windowMs: number): VolumeImbalance | null {
    const list = this.trades.get(tokenId);
    if (!list) return null;

    const cutoff = atTimeMs - windowMs;
    let buyVol = 0;
    let sellVol = 0;
    let tradeCount = 0;

    for (const t of list) {
      if (t.ts < cutoff || t.ts > atTimeMs) continue;
      tradeCount++;
      if (t.side === "BUY") buyVol += t.size;
      else sellVol += t.size;
    }

    const total = buyVol + sellVol;
    const imbalance = total > 0 ? (buyVol - sellVol) / total : 0;

    return { buyVol, sellVol, imbalance, tradeCount };
  }

  stop(): void {
    this.stopped = true;
    this.stopPing();
    this.ws?.close();
  }
}

export const tradeFlowTracker = new TradeFlowTracker();
