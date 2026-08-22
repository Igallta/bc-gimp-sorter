#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { requireCdpBase } from "./cdp-runner-config.mjs";

const cdpBase = requireCdpBase();
const playerMemberNumber = Number(process.env.MISAKA_PLAYER_MEMBER || 194331);
const repeatsArg = process.argv.find(arg => arg.startsWith("--repeats="));
const repeats = Math.max(1, Math.min(5, Number(repeatsArg?.split("=")[1]) || 3));
const deterministicOnly = process.argv.includes("--deterministic-only");

async function findBcTarget() {
  const targets = await (await fetch(`${cdpBase}/json`)).json();
  const candidates = targets.filter(item =>
    item.type === "page" &&
    /^https:\/\/[^/]*bondage-(?:europe|asia)\.com\//i.test(item.url || ""));
  for (const candidate of candidates) {
    if (!candidate?.webSocketDebuggerUrl) continue;
    const client = await connectCdp(candidate.webSocketDebuggerUrl);
    try {
      if (await evaluate(client, "Number(window.Player?.MemberNumber || 0)") === playerMemberNumber) {
        return candidate;
      }
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

const client = await connectCdp((await findBcTarget()).webSocketDebuggerUrl);
try {
  await evaluate(client, `window.__misakaRunnerRestore = {
    hadPlanDebug: Object.prototype.hasOwnProperty.call(window, "__misakaPlanDebug"),
    planDebug: window.__misakaPlanDebug,
    hadScriptVersion: Object.prototype.hasOwnProperty.call(window, "__misakaScriptVersion"),
    scriptVersion: window.__misakaScriptVersion,
  }`);
  await evaluate(client, `window.__misakaNextBootstrapOptions = { mode: "test" }`);
  await evaluate(client, await readFile(new URL("../misaka-chat.js", import.meta.url), "utf8"));
  await evaluate(client, await readFile(new URL("./context-blue.browser.js", import.meta.url), "utf8"));
  const report = await evaluate(
    client,
    `window.__runMisakaContextBlue(${JSON.stringify({ repeats, deterministicOnly })})`,
    true,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report?.summary?.failed > 0 ? 1 : 0;
} finally {
  await evaluate(client, `(() => {
    const restore = window.__misakaRunnerRestore;
    window.__misakaTestLifecycle?.dispose?.("context-suite-complete");
    delete window.__misakaTestLifecycle;
    if (restore?.hadPlanDebug) window.__misakaPlanDebug = restore.planDebug;
    else delete window.__misakaPlanDebug;
    if (restore?.hadScriptVersion) window.__misakaScriptVersion = restore.scriptVersion;
    else delete window.__misakaScriptVersion;
    delete window.__misakaRunnerRestore;
  })()`).catch(() => {});
  client.close();
}
