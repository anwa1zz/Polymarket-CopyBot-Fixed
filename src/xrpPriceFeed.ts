/**
 * Фид цены XRP через Polymarket RTDS (Chainlink TWAP). Тот же принцип,
 * что и btcPriceFeed.ts / ethPriceFeed.ts, символ xrp/usd.
 * Документация: https://docs.polymarket.com/market-data/chainlink-twap
 */

import WebSocket from "ws";

const WS_URL = "wss://ws-live-data.polymarket.com";
const SYMBOL = "xrp/usd";
const TWAP_TOPIC = "crypto_prices_twap_thirty";
const PING_INTERVAL_MS = 5 * 1000;
const BUFFER_MS = 10 * 60 * 1000;
const RECONNECT_MS = 2000;

interface Sample {
  ts: number;
  price: number;
}

interface TwapUpdateMessage {
  topic: string;
  type: string;
  timestamp: number;
  payload: {
    symbol: string;
    value: number;
    full_accuracy_value?: string;
    timestamp: number;
    window_s: number;
  };
}

class XrpPriceFeed {
  private ws: WebSocket | null = null;
  private buffer: Sample[] = [];
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      console.log("[xrpPriceFeed] подключено к Polymarket RTDS (Chainlink TWAP 30s)");
      const subscribeMsg = {
        action: "subscribe",
        subscriptions: [
          {
            topic: TWAP_TOPIC,
            type: "update",
            filters: JSON.stringify({ symbol: SYMBOL }),
          },
        ],
      };
      this.ws!.send(JSON.stringify(subscribeMsg));
      this.startPing();
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as Partial<TwapUpdateMessage>;
        if (msg.topic !== TWAP_TOPIC || msg.type !== "update" || !msg.payload) return;
        if (msg.payload.symbol !== SYMBOL) return;

        const price = Number(msg.payload.value);
        const ts = Number(msg.payload.timestamp);
        if (!Number.isFinite(price) || !Number.isFinite(ts)) return;

        this.buffer.push({ ts, price });
        const cutoff = Date.now() - BUFFER_MS;
        while (this.buffer.length && this.buffer[0].ts < cutoff) this.buffer.shift();
      } catch {
        // игнорируем не-JSON или неожиданные сообщения
      }
    });

    this.ws.on("close", () => {
      if (this.stopped) return;
      console.log(`[xrpPriceFeed] соединение закрыто, переподключение через ${RECONNECT_MS}мс`);
      this.stopPing();
      setTimeout(() => this.connect(), RECONNECT_MS);
    });

    this.ws.on("error", (err) => {
      console.error("[xrpPriceFeed] ошибка:", err.message);
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

  getPriceAt(ts: number): number | null {
    if (this.buffer.length === 0) return null;
    let closest = this.buffer[0];
    for (const s of this.buffer) {
      if (Math.abs(s.ts - ts) < Math.abs(closest.ts - ts)) closest = s;
      if (s.ts > ts) break;
    }
    return closest.price;
  }

  getLatestPrice(): number | null {
    return this.buffer.length ? this.buffer[this.buffer.length - 1].price : null;
  }

  stop(): void {
    this.stopped = true;
    this.stopPing();
    this.ws?.close();
  }
}

export const xrpPriceFeed = new XrpPriceFeed();
