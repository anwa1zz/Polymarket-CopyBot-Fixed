import "dotenv/config";
import { webcrypto } from "crypto";
import { loadConfig, ConfigError, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { ClobService } from "./clob.js";
import { DataApiClient } from "./dataApi.js";
import { CopyTrader } from "./copyTrader.js";
import { RedeemService } from "./redeem.js";
import { OnchainListener } from "./onchainListener.js";
import { createTelegramNotifier } from "./telegram.js";
import {
  loadState,
  markRedeemAttempt,
  pruneSeenTrades,
  saveState,
} from "./state.js";
import { nowSec, sleep } from "./utils.js";

const REDEEM_COOLDOWN_SEC = 600;
const IDLE_SLEEP_MS = 60000;

const idleLoop = async (): Promise<never> => {
  while (true) {
    console.log(`Fix configuration and restart the bot...`);
    await sleep(IDLE_SLEEP_MS);
  }
};

const main = async () => {
  if (!globalThis.crypto) {
    (globalThis as typeof globalThis & { crypto?: Crypto }).crypto =
      webcrypto as Crypto;
  }
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[config] ${err.message}`);
      await idleLoop();
    }
    throw err;
  }
  const logger = createLogger(config.debug);
  const state = await loadState(config.stateFile);

  const clob = await ClobService.init(
    {
      host: config.clobHost,
      chainId: config.chainId,
      privateKey: config.privateKey,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
      rpcUrl: config.rpcUrl,
      apiCreds: config.apiCreds,
    },
    logger,
  );

  const dataApi = new DataApiClient(config.dataApiHost, logger);
  const telegramNotifier = createTelegramNotifier(
    config.telegramBotToken,
    config.telegramChatId,
    logger,
  );
  if (telegramNotifier) {
    logger.info("Telegram notifications enabled.");
    void telegramNotifier.send(
      "🤖 Бот запущен и подключён к уведомлениям Telegram.",
    );
  } else {
    logger.warn(
      "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — Telegram notifications disabled.",
    );
  }
  const copyTrader = new CopyTrader(config, clob, dataApi, state, logger, telegramNotifier);

  let onchainListener: OnchainListener | null = null;
  if (config.onchainWssUrl) {
    onchainListener = new OnchainListener({
      wssUrl: config.onchainWssUrl,
      copyTraders: config.copyTraders,
      onTrade: async (trade) => {
        // Same de-dupe key as the REST path, so if both paths ever see the
        // same fill (e.g. right after a reconnect), it's only acted on once.
        await copyTrader.handleTrade(trade);
      },
      logger,
    });
    onchainListener.start();
    logger.info(
      "Real-time on-chain listener active. REST polling continues in the background as a fallback (slower interval) in case the WebSocket connection drops.",
    );
  } else {
    logger.warn(
      "ONCHAIN_WSS_URL not set — running on REST polling only. This is significantly slower to react to trades. Set ONCHAIN_WSS_URL (a wss:// RPC endpoint, e.g. from Alchemy) for real-time detection.",
    );
  }


  const redeemService = config.autoRedeem
    ? RedeemService.init(
        {
          relayerUrl: config.relayerUrl,
          chainId: config.chainId,
          privateKey: config.privateKey,
          rpcUrl: config.rpcUrl!,
          txType: config.relayerTxType,
          builderCreds: config.builderCreds,
          builderSigningUrl: config.builderSigningUrl,
          builderSigningToken: config.builderSigningToken,
        },
        logger,
      )
    : null;

  const copyLoop = async () => {
    let lastHeartbeat = 0;
    while (true) {
      try {
        const now = Date.now();
        if (now - lastHeartbeat >= 30000) {
          logger.info("Polling traders...");
          lastHeartbeat = now;
        }
        await copyTrader.runOnce();
        pruneSeenTrades(state, config.maxSeenTradesAgeSec);
        await saveState(config.stateFile, state);
      } catch (err) {
        logger.error("Copy loop error", { error: (err as Error).message });
      }
      await sleep(config.pollIntervalMs);
    }
  };

  const redeemLoop = async () => {
    if (!redeemService) return;
    while (true) {
      try {
        const positions = await dataApi.getPositions(
          config.profileAddress,
          true,
        );
        const now = nowSec();
        const eligible = positions.filter((pos) => {
          const last = state.redeemAttempts[pos.conditionId] ?? 0;
          return now - last > REDEEM_COOLDOWN_SEC;
        });

        if (eligible.length) {
          await redeemService.redeemPositions(eligible);
          const attemptedConditions = new Set(
            eligible.map((p) => p.conditionId),
          );
          for (const conditionId of attemptedConditions) {
            markRedeemAttempt(state, conditionId);
          }
          await saveState(config.stateFile, state);
        }
      } catch (err) {
        logger.error("Redeem loop error", { error: (err as Error).message });
      }
      await sleep(config.redeemPollIntervalMs);
    }
  };

  await Promise.all([copyLoop(), redeemLoop()]);
};

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    void idleLoop();
    return;
  }
  console.error(err);
  process.exit(1);
});
