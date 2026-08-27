// Standalone diagnostic script — NOT part of the bot itself, does not place
// any orders, only listens and logs. Safe to run anytime alongside the bot.
//
// It connects to TWO OR MORE Polygon WebSocket RPC providers at the same
// time and watches for the exact same on-chain event (a trade fill by one
// of your copied traders). Whichever provider's message arrives first
// "wins" for that trade. After enough trades it prints a running tally so
// you can see which provider is actually faster in practice, on your real
// traffic.
//
// HOW TO RUN (from the Railway shell, same place you ran the `node -e ...`
// latency test):
//
//   node scripts/compare-rpc.mjs
//
// It reads these environment variables (add as many as you want to test):
//   COMPARE_WSS_A   - first WSS RPC url to test
//   COMPARE_WSS_B   - second WSS RPC url to test
//   COMPARE_WSS_C   - third WSS RPC url to test (optional). If not set,
//                      this falls back to your existing ONCHAIN_WSS_URL —
//                      i.e. whatever provider the bot is actually using
//                      right now — so you can compare it against the
//                      others without adding a duplicate variable.
//   COMPARE_WSS_D   - a fourth, if you really want to (optional)
//   COPY_TRADERS    - reuses the same comma-separated trader list you
//                      already have configured for the bot
//
// At least 2 providers must be set for a comparison to make sense.
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

// Build the list of providers to test from whichever COMPARE_WSS_* vars are
// set. C falls back to ONCHAIN_WSS_URL (your bot's current provider) if not
// explicitly overridden, so "compare against what I'm using right now"
// works with zero extra setup.
const PROVIDER_SLOTS = [
  { label: "A", url: process.env.COMPARE_WSS_A },
  { label: "B", url: process.env.COMPARE_WSS_B },
  { label: "C", url: process.env.COMPARE_WSS_C || process.env.ONCHAIN_WSS_URL },
  { label: "D", url: process.env.COMPARE_WSS_D },
];

const providers = PROVIDER_SLOTS.filter((p) => !!p.url);

if (providers.length < 2) {
  console.error(
    "Need at least 2 providers to compare. Set COMPARE_WSS_A and COMPARE_WSS_B (and optionally _C, _D) in Railway Variables, then re-run.",
  );
  process.exit(1);
}

const rawTraders = process.env.COPY_TRADERS || "";
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

console.log(`Watching ${traderSet.size} trader(s) across ${providers.length} provider(s).`);
for (const p of providers) {
  console.log(`Provider ${p.label}: ${p.url.slice(0, 45)}...`);
}
console.log("Waiting for trades — this only logs, it never places orders.\n");

// key -> { times: { [label]: ms }, timer }
const seen = new Map();

// label -> { wins: number, totalDiffMs: number, comparisons: number }
const stats = new Map(providers.map((p) => [p.label, { wins: 0, totalDiffMs: 0, comparisons: 0 }]));
let totalEvents = 0;

// How long to wait, after the FIRST provider sees a trade, before finalizing
// the comparison for it (in case one provider is slow or drops the event
// entirely — we don't want to wait forever).
const FINALIZE_WINDOW_MS = 4000;

function recordSighting(label, log) {
  const key = `${log.transactionHash}:${log.args.orderHash}`;
  const now = Date.now();

  let entry = seen.get(key);
  if (!entry) {
    entry = { times: {}, timer: null };
    seen.set(key, entry);
    entry.timer = setTimeout(() => finalize(key), FINALIZE_WINDOW_MS);
  }
  if (entry.times[label] !== undefined) return; // already recorded for this provider
  entry.times[label] = now;

  // If every provider we're tracking has reported, finalize immediately
  // instead of waiting out the timer.
  if (Object.keys(entry.times).length === providers.length) {
    clearTimeout(entry.timer);
    finalize(key);
  }
}

function finalize(key) {
  const entry = seen.get(key);
  if (!entry) return;
  seen.delete(key);

  const reported = Object.entries(entry.times); // [label, ts][]
  if (reported.length < 2) return; // only one provider ever saw this trade — nothing to compare

  reported.sort((a, b) => a[1] - b[1]);
  const [, winnerTs] = reported[0];

  totalEvents += 1;
  const parts = [];
  for (const [label, ts] of reported) {
    const diff = ts - winnerTs;
    const s = stats.get(label);
    s.comparisons += 1;
    s.totalDiffMs += diff;
    if (diff === 0) s.wins += 1;
    parts.push(diff === 0 ? `${label}: first` : `${label}: +${diff}ms`);
  }

  const missing = providers.map((p) => p.label).filter((l) => !entry.times[l]);
  const missingNote = missing.length ? ` (no response from: ${missing.join(", ")})` : "";

  console.log(`[trade #${totalEvents}] ${parts.join(" | ")}${missingNote}`);
  printSummary();
}

function printSummary() {
  const lines = providers.map((p) => {
    const s = stats.get(p.label);
    const avg = s.comparisons ? (s.totalDiffMs / s.comparisons).toFixed(0) : "0";
    return `${p.label}: ${s.wins} wins / ${s.comparisons} compared, avg +${avg}ms behind the fastest`;
  });
  console.log(`  --- totals (${totalEvents} trades compared) ---`);
  for (const line of lines) console.log(`  ${line}`);
  console.log("");
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

for (const p of providers) {
  watchWith(makeClient(p.url), p.label);
}

process.on("SIGINT", () => {
  console.log("\nFinal results:");
  printSummary();
  process.exit(0);
});
