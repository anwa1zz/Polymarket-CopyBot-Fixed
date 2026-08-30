/**
 * Модуль 5: следит за выставленной лимиткой на выход (0.999).
 * Если она не исполнилась полностью за отведённое время — закрывает остаток по рынку.
 */

import { Side } from "@polymarket/clob-client-v2";
import { ClobService } from "./clob.js";
import { TelegramNotifier } from "./telegram.js";

const CHECK_INTERVAL_MS = 60 * 1000; // проверяем раз в минуту
const TIMEOUT_MS = Number(process.env.CRASH_EXIT_TIMEOUT_MIN ?? "20") * 60 * 1000;

interface WatchedExit {
  orderId: string;
  tokenId: string;
  city: string;
  binLabel: string;
  originalSize: number;
  startedAt: number;
}

export class ExitManager {
  private watched: WatchedExit[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private clob: ClobService, private telegram: TelegramNotifier | undefined) {}

  start(): void {
    this.timer = setInterval(() => this.checkAll(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  watch(exit: WatchedExit): void {
    this.watched.push(exit);
    console.log(`👁️  Следим за выходом: ${exit.city} / ${exit.binLabel} (orderId=${exit.orderId.slice(0, 12)}...)`);
  }

  private async checkAll(): Promise<void> {
    const stillWatching: WatchedExit[] = [];

    for (const w of this.watched) {
      try {
        const order = await this.clob.getOrder(w.orderId);
        const matched = Number(order.size_matched ?? 0);
        const original = Number(order.original_size ?? w.originalSize);
        const fullyFilled = matched >= original;

        if (fullyFilled) {
          console.log(`✅ Выход исполнен полностью: ${w.city} / ${w.binLabel}`);
          await this.telegram?.send(`✅ Выход исполнен полностью: ${w.city} / ${w.binLabel}`);
          continue; // убираем из наблюдения
        }

        const elapsed = Date.now() - w.startedAt;
        if (elapsed < TIMEOUT_MS) {
          stillWatching.push(w); // ждём ещё
          continue;
        }

        // Таймаут — закрываем остаток по рынку
        const remaining = original - matched;
        console.log(`⏰ Таймаут выхода: ${w.city} / ${w.binLabel}, осталось ${remaining} — закрываем по рынку`);
        await this.telegram?.send(`⏰ Выход не исполнился за ${TIMEOUT_MS / 60000} мин: ${w.city} / ${w.binLabel}\nЗакрываем остаток (${remaining}) по рынку`);

        try {
          await this.clob.cancelOrders([w.orderId]);
        } catch (err) {
          console.warn(`Не удалось отменить остаток лимитки: ${(err as Error).message}`);
        }

        if (remaining > 0) {
          try {
            const resp = await this.clob.placeLimitOrder({
              tokenId: w.tokenId,
              side: Side.SELL,
              price: 0.5, // fallback-цена, реальная берётся из живого стакана внутри placeLimitOrder
              size: remaining,
              maxSlippagePct: 5, // на выходе по таймауту допускаем больший проскальз, лишь бы закрыть позицию
            });
            console.log("✅ Остаток закрыт по рынку:", resp);
            await this.telegram?.send(`✅ Остаток закрыт по рынку: ${w.city} / ${w.binLabel}`);
          } catch (err) {
            console.error(`❌ Не удалось закрыть остаток по рынку: ${(err as Error).message}`);
            await this.telegram?.send(`❌ ОШИБКА закрытия остатка: ${w.city} / ${w.binLabel}\n${(err as Error).message}\n⚠️ Требуется ручная проверка позиции!`);
          }
        }
        // не добавляем в stillWatching — обработали (или хотя бы попытались)
      } catch (err) {
        console.warn(`Ошибка проверки ордера ${w.orderId.slice(0, 12)}...: ${(err as Error).message}`);
        stillWatching.push(w); // попробуем ещё раз в следующий цикл
      }
    }

    this.watched = stillWatching;
  }
}
