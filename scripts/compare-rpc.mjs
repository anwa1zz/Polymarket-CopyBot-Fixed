// Standalone diagnostic script — NOT part of the bot itself, does not place
// any orders, only listens and logs. Safe to run anytime alongside the bot.
//
// It connects to TWO Polygon WebSocket RPC providers at the same time and
// watches for the exact same on-chain event (a trade fill by one of your
// copied traders). Whichever provider's message arrives first "wins" for
// that trade. After enough trades it prints a running tally so you can see
// which provider is actually faster in practice, on your real traffic.
//
// HOW TO RUN (from the Railway shell, same place you ran the `node -e ...`
// latency test):
//
//   node scripts/compare-rpc.mjs
//
// It reads these environment variables:
//   COMPARE_WSS_A   - first WSS RPC url to test (falls back to your
//                      existing ONCHAIN_WSS_URL variable if not set)
//   COMPARE_WSS_B   - second WSS RPC url to test (e.g. a new QuickNode URL)
//   COPY_TRADERS    - reuses the same comma-separated trader list you
//                      already have configured for the bot
//
// If COMPARE_WSS_B is not set, add it in Railway's Variables tab first
// (Variables -> New Variable -> COMPARE_WSS_B = wss://your-quicknode-url),
// then re-run this command.
//
// Press Ctrl+C to stop. It only prints to the console — nothing is saved,
// nothing is sent anywhere else, and it never places an order.

import { createPublicClient, webSocket, parseAbiItem, getAddress } from "viem";
import { polygon } from "viem/chains";

const EXCHANGE_ADDRESSES = [
  getAddress("0xE111180000d2663C0091e4f400237545B87B996B"), // CTF Exchange V2
  getAddress("0xe2222d279d744050d28e00520010520000310F59"), // Neg Risk CTF Exchange V2
];

const ORDER_FILLED_EVENT = parseAbiItem(
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)",
);

const wssA = process.env.COMPARE_WSS_A || process.env.ONCHAIN_WSS_URL;
const wssB = process.env.COMPARE_WSS_B;
const rawTraders = process.env.COPY_TRADERS || "";

if (!wssA) {
  console.error("Missing COMPARE_WSS_A (and no ONCHAIN_WSS_URL fallback found). Set it and try again.");
  process.exit(1);
}
if (!wssB) {
  console.error("Missing COMPARE_WSS_B. Add it as a Railway variable with your second provider's WSS url, then re-run.");
  process.exit(1);
}

const traderSet = new Set(
  rawTraders
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

if (traderSet.size === 0) {
  console.error("No traders found in COPY_TRADERS — nothing to watch.");
  process.exit(1);
}

console.log(`Watching ${traderSet.size} trader(s).`);
console.log(`Provider A: ${wssA.slice(0, 40)}...`);
console.log(`Provider B: ${wssB.slice(0, 40)}...`);
console.log("Waiting for trades — this only logs, it never places orders.\n");

// key -> { A?: timestampMs, B?: timestampMs }
const seen = new Map();
const stats = { aFaster: 0, bFaster: 0, tie: 0, diffsMs: [] };

const CLEANUP_AFTER_MS = 60_000;

function recordSighting(label, log) {
  const key = `${log.transactionHash}:${log.args.orderHash}`;
  const now = Date.now();

  let entry = seen.get(key);
  if (!entry) {
    entry = {};
    seen.set(key, entry);
  }
  if (entry[label] !== undefined) return; // already recorded for this provider
  entry[label] = now;

  if (entry.A !== undefined && entry.B !== undefined) {
    const diff = entry.A - entry.B; // positive = B was faster
    stats.diffsMs.push(Math.abs(diff));
    if (diff === 0) {
      stats.tie += 1;
      console.log(`[TIE] both providers saw the trade at the same ms`);
    } else if (diff > 0) {
      stats.bFaster += 1;
      console.log(`[B faster by ${diff}ms] tx=${log.transactionHash.slice(0, 12)}...`);
    } else {
      stats.aFaster += 1;
      console.log(`[A faster by ${-diff}ms] tx=${log.transactionHash.slice(0, 12)}...`);
    }
    printSummary();
  }
}

function printSummary() {
  const total = stats.aFaster + stats.bFaster + stats.tie;
  const avg = stats.diffsMs.length
    ? (stats.diffsMs.reduce((a, b) => a + b, 0) / stats.diffsMs.length).toFixed(0)
    : "0";
  console.log(
    `  --- so far: ${total} compared | A faster: ${stats.aFaster} | B faster: ${stats.bFaster} | ties: ${stats.tie} | avg diff: ${avg}ms ---\n`,
  );
}

function makeClient(wssUrl) {
  return createPublicClient({
    chain: polygon,
    transport: webSocket(wssUrl, {
      reconnect: { attempts: Infinity, delay: 2000 },
      keepAlive: { interval: 15000 },
    }),
  });
}

function watchWith(client, label) {
  for (const address of EXCHANGE_ADDRESSES) {
    client.watchEvent({
      address,
      event: ORDER_FILLED_EVENT,
      args: { maker: [...traderSet].map((t) => getAddress(t)) },
      onLogs: (logs) => logs.forEach((l) => recordSighting(label, l)),
      onError: (err) => console.error(`[${label}] watchEvent(maker) error:`, err.message),
    });
    client.watchEvent({
      address,
      event: ORDER_FILLED_EVENT,
      args: { taker: [...traderSet].map((t) => getAddress(t)) },
      onLogs: (logs) => logs.forEach((l) => recordSighting(label, l)),
      onError: (err) => console.error(`[${label}] watchEvent(taker) error:`, err.message),
    });
  }
}

const clientA = makeClient(wssA);
const clientB = makeClient(wssB);

watchWith(clientA, "A");
watchWith(clientB, "B");

// Periodic cleanup so `seen` doesn't grow forever if one provider never
// reports a given trade (e.g. it dropped the event).
setInterval(() => {
  const cutoff = Date.now() - CLEANUP_AFTER_MS;
  for (const [key, entry] of seen) {
    const oldest = Math.min(entry.A ?? Infinity, entry.B ?? Infinity);
    if (oldest < cutoff) seen.delete(key);
  }
}, 30_000);

process.on("SIGINT", () => {
  console.log("\nFinal results:");
  printSummary();
  process.exit(0);
});
