#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

const cdpBase = process.env.MISAKA_CDP_URL || "http://127.0.0.1:9222";
const repeatsArg = process.argv.find(arg => arg.startsWith("--repeats="));
const repeats = Math.max(1, Math.min(5, Number(repeatsArg?.split("=")[1]) || 3));
const chatUrl = new URL("../misaka-chat.js", import.meta.url);
const suiteUrl = new URL("./sticker-blue.browser.js", import.meta.url);

async function findBcTarget() {
  const response = await fetch(`${cdpBase}/json`);
  if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
  const targets = await response.json();
  const target = targets.find(item =>
    item.type === "page" &&
    /^https:\/\/[^/]*bondage-(?:europe|asia)\.com\//i.test(item.url || "")
  );
  if (!target?.webSocketDebuggerUrl) throw new Error("No active Bondage Club page found on CDP");
  return target;
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("open", () => resolve({
      call(method, params = {}) {
        return new Promise((callResolve, callReject) => {
          const id = nextId++;
          pending.set(id, { resolve: callResolve, reject: callReject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { socket.close(); },
    }));
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    socket.addEventListener("error", () => reject(new Error("CDP websocket connection failed")));
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
    throw new Error(result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "Runtime.evaluate failed");
  }
  return result.result?.value;
}

const target = await findBcTarget();
const client = await connectCdp(target.webSocketDebuggerUrl);

try {
  // Ensure the local candidate starts with stickers enabled, then restore the
  // user's saved switch after the read-only suite.
  const savedSwitch = await evaluate(client,
    `localStorage.getItem("misaka_sticker_enabled")`);
  await evaluate(client, `localStorage.setItem("misaka_sticker_enabled", "true")`);
  try {
    await evaluate(client, await readFile(chatUrl, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 2500));
    await evaluate(client, await readFile(suiteUrl, "utf8"));
    const report = await evaluate(
      client,
      `window.__runMisakaStickerBlue(${JSON.stringify({ repeats })})`,
      true,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report?.summary?.failed > 0 ? 1 : 0;
  } finally {
    if (savedSwitch == null) {
      await evaluate(client, `localStorage.removeItem("misaka_sticker_enabled")`);
    } else {
      await evaluate(client,
        `localStorage.setItem("misaka_sticker_enabled", ${JSON.stringify(savedSwitch)})`);
    }
  }
} finally {
  client.close();
}
