/**
 * Модуль 2: слежение за ценами в реальном времени через CLOB WebSocket.
 * Подписывается на список токенов, вызывает callback при каждом изменении цены.
 */

import WebSocket from "ws";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface PriceUpdate {
  tokenId: string;
  bestAsk: number | null;
  bestBid: number | null;
  timestamp: number;
}

export class PriceWatcher {
  private ws: WebSocket | null = null;
  private tokenIds: string[];
  private onUpdate: (update: PriceUpdate) => void;
  private stopped = false;

  constructor(tokenIds: string[], onUpdate: (update: PriceUpdate) => void) {
    this.tokenIds = tokenIds;
    this.onUpdate = onUpdate;
  }

  start(): void {
    this.connect(1000);
  }

  private connect(backoffMs: number): void {
    if (this.stopped) return;

    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      console.log(`[priceWatcher] подключено, подписка на ${this.tokenIds.length} токенов`);
      this.ws!.send(JSON.stringify({ type: "market", assets_ids: this.tokenIds }));
    });

    this.ws.on("message", (raw: Buffer) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on("close", () => {
      if (this.stopped) return;
      console.log(`[priceWatcher] соединение закрыто, переподключение через ${backoffMs}мс`);
      setTimeout(() => this.connect(Math.min(backoffMs * 2, 30000)), backoffMs);
    });

    this.ws.on("error", (err) => {
      console.error("[priceWatcher] ошибка:", err.message);
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const events = Array.isArray(msg) ? msg : [msg];
    for (const event of events) {
      const tokenId = event.asset_id;
      if (!tokenId) continue;

      const asks = (event.asks ?? []).map((a: any) => Number(a.price)).filter((p: number) => Number.isFinite(p));
      const bids = (event.bids ?? []).map((b: any) => Number(b.price)).filter((p: number) => Number.isFinite(p));

      this.onUpdate({
        tokenId,
        bestAsk: asks.length ? Math.min(...asks) : null,
        bestBid: bids.length ? Math.max(...bids) : null,
        timestamp: Date.now(),
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }
}

// Тестовый запуск: npx tsx src/priceWatcher.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  import("./marketDiscovery.js").then(async ({ discoverWeatherMarkets }) => {
    const markets = await discoverWeatherMarkets();
    // Берём 40 рынков вместо 3 — больше шансов поймать реальное движение цены
    const testMarkets = markets.slice(0, 40);
    const tokenIds = testMarkets.flatMap((m) => m.bins.flatMap((b) => [b.yesTokenId, b.noTokenId]));
    console.log(`Тестируем на ${testMarkets.length} рынках, ${tokenIds.length} токенов`);

    let updateCount = 0;
    const watcher = new PriceWatcher(tokenIds, (update) => {
      updateCount++;
      console.log(`[${new Date(update.timestamp).toISOString()}] #${updateCount} token=${update.tokenId.slice(0, 12)}... ask=${update.bestAsk} bid=${update.bestBid}`);
    });
    watcher.start();

    setInterval(() => {
      console.log(`--- всего сообщений получено: ${updateCount} ---`);
    }, 15000);
  });
}