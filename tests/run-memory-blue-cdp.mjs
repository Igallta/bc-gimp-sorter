#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { requireCdpBase } from "./cdp-runner-config.mjs";

const cdpBase = requireCdpBase();
const playerMemberNumber = Number(process.env.MISAKA_PLAYER_MEMBER || 194331);
const repeatsArg = process.argv.find(arg => arg.startsWith("--repeats="));
const repeats = Math.max(1, Math.min(10, Number(repeatsArg?.split("=")[1]) || 3));
const idsArg = process.argv.find(arg => arg.startsWith("--ids="));
const ids = idsArg
  ? idsArg.split("=")[1].split(",").map(value => value.trim()).filter(Boolean)
  : null;
const chatUrl = new URL("../misaka-chat.js", import.meta.url);
const suiteUrl = new URL("./memory-blue.browser.js", import.meta.url);

async function findBcTarget() {
  const response = await fetch(`${cdpBase}/json`);
  if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
  const targets = await response.json();
  const candidates = targets.filter(item =>
    item.type === "page" &&
    /^https:\/\/[^/]*bondage-(?:europe|asia)\.com\//i.test(item.url || "")
  );
  for (const candidate of candidates) {
    if (!candidate?.webSocketDebuggerUrl) continue;
    const client = await connectCdp(candidate.webSocketDebuggerUrl);
    try {
      const memberNumber = await evaluate(
        client,
        "Number(window.Player?.MemberNumber || 0)",
      );
      if (memberNumber === playerMemberNumber) return candidate;
    } finally {
      client.close();
    }
  }
  throw new Error(`No active Bondage Club page found for player #${playerMemberNumber}`);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();

    socket.addEventListener("open", () => {
      resolve({
        call(method, params = {}) {
          return new Promise((callResolve, callReject) => {
            const id = nextId++;
            pending.set(id, { resolve: callResolve, reject: callReject });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    socket.addEventListener("error", () => reject(new Error("CDP websocket connection failed")));
    socket.addEventListener("close", () => {
      for (const waiter of pending.values()) waiter.reject(new Error("CDP websocket closed"));
      pending.clear();
    });
  });
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: false,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "Runtime.evaluate failed";
    throw new Error(description);
  }
  return result.result?.value;
}

const target = await findBcTarget();
const client = await connectCdp(target.webSocketDebuggerUrl);

try {
  // Always exercise the local candidate rather than whichever installed
  // userscript version the current BC tab happened to load.
  await evaluate(client, await readFile(chatUrl, "utf8"));
  await new Promise(resolve => setTimeout(resolve, 2500));
  const source = await readFile(suiteUrl, "utf8");
  await evaluate(client, source);
  const report = await evaluate(
    client,
    `window.__runMisakaMemoryBlue(${JSON.stringify({ repeats, ids })})`,
    true,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report?.summary?.failed > 0 ? 1 : 0;
} finally {
  client.close();
}
