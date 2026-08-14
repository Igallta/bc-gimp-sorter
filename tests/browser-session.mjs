#!/usr/bin/env node

import { execFile } from "node:child_process";
import process from "node:process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PROFILE = process.env.MISAKA_BROWSER_PROFILE || "user";
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const PLAYER_MEMBER_NUMBER = Number(process.env.MISAKA_PLAYER_MEMBER || 194331);
const EVALUATE_TIMEOUT_MS = Math.max(5_000, Number(process.env.MISAKA_BROWSER_EVALUATE_TIMEOUT_MS) || 120_000);
const GATEWAY_TIMEOUT_MS = Math.max(EVALUATE_TIMEOUT_MS + 10_000,
  Number(process.env.MISAKA_BROWSER_GATEWAY_TIMEOUT_MS) || 180_000);
const CDP_BASE = process.env.MISAKA_CDP_URL || "";
const BRIDGE_SLOT = "__misakaRunnerBrowserBridge";
let bridgeServer = null;
let bridgeServerPort = 0;
let bridgePoll = null;
let bridgePollTimer = null;
let bridgeCommandId = 0;
let activeOfficialClients = 0;
let bridgeShutdownTimer = null;
const bridgeQueue = [];
const bridgeResults = new Map();

function isBondageClubUrl(url) {
  return /^https:\/\/[^/]*bondage-(?:europe|asia)\.com\//i.test(url || "");
}

function targetReference(tab) {
  return tab?.suggestedTargetId || tab?.tabId || tab?.targetId || "";
}

function parseJsonOutput(stdout, stderr, description) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const detail = String(stderr || "").trim();
    throw new Error(`${description} returned invalid JSON${detail ? `: ${detail}` : ""}`, { cause: error });
  }
}

async function openClawBrowser(args, description) {
  let result;
  try {
    result = await execFileAsync(OPENCLAW_BIN, args, {
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 32 * 1024 * 1024,
      timeout: GATEWAY_TIMEOUT_MS + 5_000,
    });
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    throw new Error(`${description} failed${stderr ? `: ${stderr}` : `: ${error.message}`}`, { cause: error });
  }
  return parseJsonOutput(result.stdout, result.stderr, description);
}

async function listOfficialTabs() {
  const result = await openClawBrowser([
    "browser",
    "--browser-profile", DEFAULT_PROFILE,
    "--json",
    "--timeout", String(GATEWAY_TIMEOUT_MS),
    "tabs",
  ], "OpenClaw browser tabs");
  return Array.isArray(result?.tabs) ? result.tabs : [];
}

async function evaluateBrowserFunction(targetId, fnSource) {
  const result = await openClawBrowser([
    "browser",
    "--browser-profile", DEFAULT_PROFILE,
    "--json",
    "--timeout", String(GATEWAY_TIMEOUT_MS),
    "evaluate",
    "--fn", fnSource,
    "--target-id", targetId,
    "--timeout-ms", String(EVALUATE_TIMEOUT_MS),
  ], "OpenClaw browser evaluate");
  return result?.result;
}

function bridgeHeaders(contentType = "application/json") {
  return {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  };
}

function writeBridgeJson(response, value, status = 200) {
  response.writeHead(status, bridgeHeaders());
  response.end(JSON.stringify(value));
}

function dispatchBridgeCommand() {
  if (!bridgePoll || bridgeQueue.length === 0) return;
  const poll = bridgePoll;
  bridgePoll = null;
  if (bridgePollTimer) clearTimeout(bridgePollTimer);
  bridgePollTimer = null;
  writeBridgeJson(poll.response, bridgeQueue.shift());
}

function settleBridgeResult(id, payload) {
  const waiter = bridgeResults.get(id);
  if (!waiter) return;
  bridgeResults.delete(id);
  clearTimeout(waiter.timer);
  if (payload?.ok) waiter.resolve(payload.value);
  else waiter.reject(new Error(payload?.error || "Browser bridge evaluation failed"));
  scheduleBridgeShutdown();
}

function scheduleBridgeShutdown() {
  if (bridgeShutdownTimer) clearTimeout(bridgeShutdownTimer);
  bridgeShutdownTimer = setTimeout(() => {
    bridgeShutdownTimer = null;
    if (activeOfficialClients > 0 || bridgeResults.size > 0 || bridgeQueue.length > 0 || bridgePoll) return;
    if (bridgeServer) {
      bridgeServer.close();
      bridgeServer = null;
      bridgeServerPort = 0;
    }
  }, 250);
}

async function ensureBridgeServer() {
  if (bridgeServer) return;
  bridgeServer = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...bridgeHeaders(),
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/bridge/next") {
      if (bridgePoll) writeBridgeJson(bridgePoll.response, null);
      bridgePoll = { response };
      dispatchBridgeCommand();
      bridgePollTimer = setTimeout(() => {
        if (!bridgePoll || bridgePoll.response !== response) return;
        bridgePoll = null;
        writeBridgeJson(response, null);
      }, 25_000);
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/bridge/result/")) {
      const id = decodeURIComponent(url.pathname.slice("/bridge/result/".length));
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        try {
          settleBridgeResult(id, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          response.writeHead(204, bridgeHeaders());
          response.end();
        } catch (error) {
          writeBridgeJson(response, { error: String(error?.message || error) }, 400);
        }
      });
      return;
    }
    writeBridgeJson(response, { error: "not found" }, 404);
  });
  await new Promise((resolve, reject) => {
    bridgeServer.once("error", reject);
    bridgeServer.listen(0, "127.0.0.1", () => {
      bridgeServerPort = bridgeServer.address().port;
      resolve();
    });
  });
}

function queueBridgeCommand(source) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now().toString(36)}-${++bridgeCommandId}`;
    const timer = setTimeout(() => {
      bridgeResults.delete(id);
      reject(new Error("Browser bridge evaluation timed out"));
    }, GATEWAY_TIMEOUT_MS);
    bridgeResults.set(id, { resolve, reject, timer });
    bridgeQueue.push({ id, source });
    dispatchBridgeCommand();
  });
}

async function installBridge(targetId) {
  await ensureBridgeServer();
  const base = `http://127.0.0.1:${bridgeServerPort}`;
  await evaluateBrowserFunction(targetId, `() => {
    const slot = ${JSON.stringify(BRIDGE_SLOT)};
    const base = ${JSON.stringify(base)};
    const old = globalThis[slot];
    if (old?.active && old.base === base) return true;
    if (old) old.active = false;
    const bridge = { base, active: true };
    globalThis[slot] = bridge;
    (async () => {
      while (globalThis[slot] === bridge && bridge.active) {
        try {
          const response = await fetch(base + "/bridge/next", { cache: "no-store" });
          const command = await response.json();
          if (!command?.id) continue;
          let payload;
          try {
            const value = await eval(command.source);
            payload = { ok: true, value: value === undefined ? null : value };
          } catch (error) {
            payload = { ok: false, error: String(error?.stack || error?.message || error) };
          }
          await fetch(base + "/bridge/result/" + encodeURIComponent(command.id), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    })();
    return true;
  }`);
}

function createOfficialClient(targetId) {
  let closed = false;
  let bridgeReady = false;
  activeOfficialClients++;
  return {
    transport: "openclaw-browser",
    targetId,
    async call(method, params = {}) {
      if (closed) throw new Error("Browser session is closed");
      if (method === "Runtime.evaluate") {
        if (!bridgeReady) {
          await installBridge(targetId);
          bridgeReady = true;
        }
        const value = await queueBridgeCommand(params.expression || "");
        return { result: { value } };
      }
      if (method === "Runtime.getHeapUsage") {
        if (!bridgeReady) {
          await installBridge(targetId);
          bridgeReady = true;
        }
        const value = await queueBridgeCommand(`(() => {
          const memory = globalThis.performance?.memory;
          return memory ? {
            usedSize: Number(memory.usedJSHeapSize) || 0,
            totalSize: Number(memory.totalJSHeapSize) || 0,
            jsHeapSizeLimit: Number(memory.jsHeapSizeLimit) || 0,
          } : null;
        })()`);
        return value || { usedSize: 0, totalSize: 0, jsHeapSizeLimit: 0 };
      }
      if (method === "HeapProfiler.collectGarbage") return {};
      throw new Error(`OpenClaw browser adapter does not support ${method}`);
    },
    close() {
      if (closed) return;
      closed = true;
      activeOfficialClients = Math.max(0, activeOfficialClients - 1);
      if (bridgeReady) {
        queueBridgeCommand(`(() => {
          const bridge = globalThis[${JSON.stringify(BRIDGE_SLOT)}];
          if (bridge) bridge.active = false;
          return true;
        })()`).catch(() => {});
      }
      scheduleBridgeShutdown();
    },
  };
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    let settled = false;
    const pending = new Map();
    const failPending = error => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    socket.addEventListener("open", () => {
      settled = true;
      resolve({
        transport: "cdp",
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
    socket.addEventListener("error", () => {
      const error = new Error("CDP websocket connection failed");
      if (!settled) reject(error);
      failPending(error);
    });
    socket.addEventListener("close", () => {
      const error = new Error("CDP websocket closed");
      if (!settled) reject(error);
      failPending(error);
    });
  });
}

async function findLegacyTarget() {
  const response = await fetch(`${CDP_BASE}/json`);
  if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
  const targets = await response.json();
  const candidates = targets.filter(item => item.type === "page" && isBondageClubUrl(item.url));
  for (const target of candidates) {
    if (!target?.webSocketDebuggerUrl) continue;
    const client = await connectCdp(target.webSocketDebuggerUrl);
    try {
      if (await evaluate(client, "Number(window.Player?.MemberNumber || 0)") === PLAYER_MEMBER_NUMBER) {
        return { target, client };
      }
    } catch {
      client.close();
      continue;
    }
    client.close();
  }
  throw new Error(`No active Bondage Club page found for player #${PLAYER_MEMBER_NUMBER}`);
}

async function findOfficialTarget() {
  const tabs = await listOfficialTabs();
  const candidates = tabs.filter(tab => tab.type === "page" && isBondageClubUrl(tab.url));
  for (const tab of candidates) {
    const targetId = targetReference(tab);
    if (!targetId) continue;
    const client = createOfficialClient(targetId);
    try {
      if (await evaluate(client, "Number(window.Player?.MemberNumber || 0)") === PLAYER_MEMBER_NUMBER) {
        return { target: { ...tab, targetId }, client };
      }
    } catch {
      client.close();
      continue;
    }
    client.close();
  }
  throw new Error(`No active Bondage Club page found for player #${PLAYER_MEMBER_NUMBER} via profile ${DEFAULT_PROFILE}`);
}

export async function findMisakaTarget() {
  return CDP_BASE ? findLegacyTarget() : findOfficialTarget();
}

export async function evaluate(client, expression, awaitPromise = false) {
  // The official browser evaluate route awaits returned promises itself. Keep
  // the old argument for runner compatibility; raw CDP still receives it.
  const result = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: false,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

export { PLAYER_MEMBER_NUMBER };
