/**
 * research-combined.ts — ОДИН процесс, который запускает ОБА исследовательских
 * модуля сразу: research-grid.ts (fixed/adaptive + микро-метрики) и
 * research-grid-levels.ts (альтернативные уровни входа). Сделано специально,
 * чтобы не заводить второй сервис на Railway — это ЕДИНСТВЕННЫЙ файл,
 * который нужно указать в Custom Start Command:
 *
 *   npx tsx src/research-combined.ts
 *
 * ВАЖНО, почему это не просто "склеить два файла в один": у Telegram Bot API
 * нельзя, чтобы ДВА независимых процесса одновременно делали getUpdates по
 * ОДНОМУ И ТОМУ ЖЕ токену бота — второй такой запрос вернёт ошибку
 * "409 Conflict". Поэтому здесь один-единственный цикл опроса Telegram,
 * который на каждое входящее сообщение сначала пробует найти совпадение
 * среди команд research-grid, и если не нашёл — среди команд research-levels.
 *
 * Также важно, что оба модуля используют ОДНИ И ТЕ ЖЕ фиды цены (btcPriceFeed
 * и т.д.) и ОДИН И ТОТ ЖЕ tradeFlowTracker — если бы каждый модуль запускал
 * их сам (как в своём собственном main()), в комбинированном процессе они
 * запустились бы ДВАЖДЫ и открыли бы лишние WebSocket-соединения. Поэтому
 * оба файла переделаны так, что их собственный main() (со стартом фидов)
 * запускается ТОЛЬКО при прямом запуске файла (npx tsx src/research-grid.ts
 * напрямую) — а при импорте отсюда ничего не стартует само, весь запуск
 * делает этот файл, один раз.
 *
 * Файлы состояния у модулей РАЗНЫЕ (research-grid-state.json и
 * research-grid-levels-state.json) — данные друг другу не мешают, каждый
 * копит свою историю независимо, просто в одном процессе.
 */

import "dotenv/config";
import { btcPriceFeed } from "./btcPriceFeed.js";
import { ethPriceFeed } from "./ethPriceFeed.js";
import { solPriceFeed } from "./solPriceFeed.js";
import { xrpPriceFeed } from "./xrpPriceFeed.js";
import { dogePriceFeed } from "./dogePriceFeed.js";
import { tradeFlowTracker } from "./tradeFlowTracker.js";
import { createTelegramNotifier } from "./telegram.js";
import { createLogger } from "./logger.js";
import {
  ResearchGridLogger,
  tryHandleResearchGridCommand,
  startResearchGridInfra,
  sendReportToTelegram,
} from "./Research.js";
import { LevelsResearchLogger, tryHandleLevelsCommand } from "./ResearchLevels.js";

/**
 * Единый опрос Telegram для ОБОИХ модулей — единственный getUpdates-цикл на
 * весь процесс, чтобы не ловить конфликт с самим собой.
 */
async function pollCombinedTelegram(
  botToken: string,
  chatId: string,
  telegram: ReturnType<typeof createTelegramNotifier>,
  gridResearch: ResearchGridLogger,
  levelsResearch: LevelsResearchLogger,
): Promise<void> {
  let offset = 0;
  const apiUrl = `https://api.telegram.org/bot${botToken}/getUpdates`;

  for (;;) {
    try {
      const resp = await fetch(`${apiUrl}?offset=${offset}&timeout=25`);
      if (!resp.ok) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const data = await resp.json();
      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text || String(msg.chat?.id) !== String(chatId)) continue;

        // Сначала пробуем команды research-grid (крипта итог/адаптив/объём/
        // замедление/микро), если не подошло — пробуем команды уровней
        // (уровни итог/уровни полная/объемгейт). Наборы команд не
        // пересекаются, поэтому порядок проверки тут не критичен.
        const gridResult = tryHandleResearchGridCommand(msg.text, gridResearch);
        if (gridResult) {
          console.log(`[telegram] Запрос (research-grid): "${msg.text}"`);
          await sendReportToTelegram(telegram, gridResult.header, gridResult.report);
          continue;
        }

        const levelsResult = tryHandleLevelsCommand(msg.text, levelsResearch);
        if (levelsResult) {
          console.log(`[telegram] Запрос (уровни): "${msg.text}"`);
          await sendReportToTelegram(telegram, levelsResult.header, levelsResult.report);
          continue;
        }
      }
    } catch (err) {
      console.error("[telegram poll] ошибка:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  console.log("=== research-combined: research-grid + research-grid-levels В ОДНОМ ПРОЦЕССЕ ===");

  // Фиды цены и tradeFlowTracker — ОБЩИЕ для обоих модулей, стартуем ОДИН РАЗ здесь.
  btcPriceFeed.start();
  ethPriceFeed.start();
  solPriceFeed.start();
  xrpPriceFeed.start();
  dogePriceFeed.start();
  tradeFlowTracker.start();

  // volTracker специфичен для research-grid.ts (нужен только для adaptive-сетки) —
  // тоже стартуем один раз, через экспортированную функцию.
  startResearchGridInfra();

  const logger = createLogger(false);
  const telegram = createTelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, logger);

  const gridResearch = new ResearchGridLogger();
  gridResearch.start();
  console.log("research-grid (fixed/adaptive/микро) запущен.");

  const levelsResearch = new LevelsResearchLogger();
  levelsResearch.start();
  console.log("research-grid-levels (уровни 1/2/3/4/5/8/13) запущен.");

  if (telegram && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    console.log(
      "Единый Telegram-опрос запущен. Команды research-grid: крипта итог / полная таблица / адаптив / " +
        "полная адаптив / объём / замедление / микро. Команды уровней: уровни итог / уровни полная / объемгейт.",
    );
    pollCombinedTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, telegram, gridResearch, levelsResearch);
  } else {
    console.log("Telegram не настроен — отчёты будут доступны только через логи консоли.");
  }

  const sendFinal = async () => {
    console.log("\n" + gridResearch.buildCompactReport());
    console.log("\n" + levelsResearch.buildCompactReport());
    gridResearch.saveState();
    levelsResearch.saveState();
    if (telegram) {
      await sendReportToTelegram(telegram, "<b>🌙 Финальный отчёт (research-grid)</b>", gridResearch.buildCompactReport());
      await sendReportToTelegram(telegram, "<b>🌙 Финальный отчёт (уровни)</b>", levelsResearch.buildCompactReport());
    }
    process.exit(0);
  };

  process.on("SIGINT", sendFinal);
  process.on("SIGTERM", sendFinal);
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
  process.exit(1);
});
