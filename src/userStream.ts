/**
 * Авторизованный User Stream Polymarket — в реальном времени сообщает
 * статус сделок по нашему аккаунту (matched -> mined -> confirmed / failed).
 *
 * Зачем это нужно: обычный ответ CLOB на market-ордер говорит "success,
 * status: matched" сразу же, но это лишь оффчейн-мэтчинг. Финальное
 * ончейн-исполнение (settlement) может теоретически зафейлиться уже
 * ПОСЛЕ этого ответа — а бот об этом раньше никак не узнавал и просто
 * доверял первому "success". User Stream даёт честное финальное
 * подтверждение (CONFIRMED) или сообщает о провале (FAILED).
 *
 * Документация: https://docs.polymarket.com/trading/realtime-order-updates
 */

import WebSocket from "ws";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const PING_INTERVAL_MS = 10 * 1000; // сервер ждёт текстовый "PING" каждые 10с, отвечает "PONG"
const RECONNECT_MS = 2000;

export interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export type TradeStatus =
  | "MATCHED_NOT_BROADCASTED"
  | "MATCHED"
  | "MINED"
  | "CONFIRMED"
  | "RETRYING"
  | "FAILED";

export interface TradeRecord {
  status: TradeStatus;
  transactionHash: string | null;
  matchedAmount: string | null;
  price: string | null;
  updatedAt: number;
}

interface Waiter {
  resolve: (record: TradeRecord | null) => void;
  timer: NodeJS.Timeout;
}

class UserStream {
  private ws: WebSocket | null = null;
  private creds: ApiCreds | null = null;
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;

  // последнее известное состояние сделки по taker_order_id
  private tradesByOrderId = new Map<string, TradeRecord>();
  private waiters = new Map<string, Waiter[]>();

  start(creds: ApiCreds): void {
    this.creds = creds;
    this.connect();
  }

  private connect(): void {
    if (this.stopped || !this.creds) return;
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      console.log("[userStream] подключено, авторизация...");
      this.ws!.send(
        JSON.stringify({
          auth: {
            apiKey: this.creds!.key,
            secret: this.creds!.secret,
            passphrase: this.creds!.passphrase,
          },
          type: "user",
        }),
      );
      this.startPing();
    });

    this.ws.on("message", (raw: Buffer) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on("close", () => {
      if (this.stopped) return;
      console.log(`[userStream] соединение закрыто, переподключение через ${RECONNECT_MS}мс`);
      this.stopPing();
      setTimeout(() => this.connect(), RECONNECT_MS);
    });

    this.ws.on("error", (err) => {
      console.error("[userStream] ошибка:", err.message);
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send("PING");
        } catch {
          // проигнорируем — на следующем reconnect всё равно пересоздастся
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
      return; // например, текстовый "PONG" — не JSON, просто игнорируем
    }
    if (msg.event_type !== "trade") return;

    const orderId: string | undefined = msg.taker_order_id;
    if (!orderId) return;

    const record: TradeRecord = {
      status: msg.status,
      transactionHash: msg.transaction_hash ?? null,
      matchedAmount: msg.size ?? null,
      price: msg.price ?? null,
      updatedAt: Date.now(),
    };
    this.tradesByOrderId.set(orderId, record);

    const isTerminal = record.status === "CONFIRMED" || record.status === "FAILED";
    if (isTerminal) {
      const waiting = this.waiters.get(orderId);
      if (waiting) {
        for (const w of waiting) {
          clearTimeout(w.timer);
          w.resolve(record);
        }
        this.waiters.delete(orderId);
      }
    }
  }

  /**
   * Ждёт терминальный статус сделки (CONFIRMED или FAILED) по orderId.
   * Возвращает null, если не дождались за timeoutMs — это НЕ значит,
   * что сделка провалилась, просто подтверждение ещё не пришло
   * (например, соединение только переподключилось).
   */
  waitForConfirmation(orderId: string, timeoutMs: number): Promise<TradeRecord | null> {
    const existing = this.tradesByOrderId.get(orderId);
    if (existing && (existing.status === "CONFIRMED" || existing.status === "FAILED")) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(orderId);
        if (list) {
          const idx = list.findIndex((w) => w.timer === timer);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) this.waiters.delete(orderId);
        }
        resolve(null);
      }, timeoutMs);

      const list = this.waiters.get(orderId) ?? [];
      list.push({ resolve, timer });
      this.waiters.set(orderId, list);
    });
  }

  stop(): void {
    this.stopped = true;
    this.stopPing();
    this.ws?.close();
  }
}

export const userStream = new UserStream();
