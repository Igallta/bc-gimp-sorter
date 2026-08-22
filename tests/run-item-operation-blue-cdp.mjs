#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { requireCdpBase } from "./cdp-runner-config.mjs";

const cdpBase = requireCdpBase();
const playerMemberNumber = Number(process.env.MISAKA_PLAYER_MEMBER || 194331);
const repeatsArg = process.argv.find(arg => arg.startsWith("--repeats="));
const repeats = Math.max(1, Math.min(5, Number(repeatsArg?.split("=")[1]) || 3));

async function connectCdp(url) {
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

async function findMisakaTarget() {
  const targets = await (await fetch(`${cdpBase}/json`)).json();
  for (const target of targets) {
    if (target.type !== "page" ||
        !/^https:\/\/[^/]*bondage-(?:europe|asia)\.com\//i.test(target.url || "") ||
        !target.webSocketDebuggerUrl) continue;
    const client = await connectCdp(target.webSocketDebuggerUrl);
    try {
      if (await evaluate(client, "Number(window.Player?.MemberNumber || 0)") === playerMemberNumber) {
        return client;
      }
    } catch (_) {}
    client.close();
  }
  throw new Error(`No active Misaka #${playerMemberNumber} Bondage Club page found on CDP`);
}

const client = await findMisakaTarget();
try {
  await evaluate(client, `window.__misakaRunnerRestore = {
    hadPlanDebug: Object.prototype.hasOwnProperty.call(window, "__misakaPlanDebug"),
    planDebug: window.__misakaPlanDebug,
    hadScriptVersion: Object.prototype.hasOwnProperty.call(window, "__misakaScriptVersion"),
    scriptVersion: window.__misakaScriptVersion,
  }`);
  await evaluate(client, `window.__misakaNextBootstrapOptions = { mode: "test" }`);
  await evaluate(client, await readFile(new URL("../misaka-chat.js", import.meta.url), "utf8"));

  const fixture = await evaluate(client, `(() => {
    const chars = window.ChatRoomCharacter || [];
    const target = chars.find(character =>
      /^(?:rin)$/i.test(String(character?.Nickname || character?.Name || "").trim())) ||
      chars.find(character =>
        Number(character?.MemberNumber) !== Number(window.Player?.MemberNumber));
    const sender = chars.find(character =>
      /^(?:咲|misaki)$/i.test(String(character?.Nickname || character?.Name || "").trim())) ||
      chars.find(character => Number(character?.MemberNumber) !== Number(window.Player?.MemberNumber));
    return {
      target: target ? {
        name: target.Nickname || target.Name,
        memberNumber: Number(target.MemberNumber),
      } : null,
      sender: sender ? {
        name: sender.Nickname || sender.Name,
        memberNumber: Number(sender.MemberNumber),
      } : null,
    };
  })()`);
  if (!fixture?.target) throw new Error("No non-Misaka target is currently present in the room");
  if (!fixture?.sender) throw new Error("No non-Misaka sender is currently present in the room");

  const prompts = [
    `御坂，给${fixture.target.name}发个窝窝`,
    `御坂，给${fixture.target.name}一个宠物窝`,
    `御坂，给${fixture.target.name}装备一个PetBed宠物窝`,
  ];
  const results = [];
  for (let repetition = 1; repetition <= repeats; repetition++) {
    for (const content of prompts) {
      const actual = await evaluate(
        client,
        `window.__misakaPlanDebug.dryRunPlannedRequestForTest(` +
          `${fixture.sender.memberNumber},${JSON.stringify(fixture.sender.name)},${JSON.stringify(content)})`,
        true,
      );
      const plannedOperation = actual?.requestPlan?.operations?.find(operation =>
        (operation?.targets || []).map(Number).includes(fixture.target.memberNumber) &&
        (operation?.types || []).some(type =>
          ["itemadd", "itemset"].includes(String(type))));
      const itemAdd = actual?.filtered?.allowed?.find(command =>
        command?.type === "itemadd" &&
        Number(command?.memberNumber) === fixture.target.memberNumber &&
        command?.item === "PetBed");
      const resolution = actual?.resolutions?.find(entry =>
        entry?.command?.type === "itemadd" &&
        Number(entry?.command?.memberNumber) === fixture.target.memberNumber &&
        entry?.command?.item === "PetBed");
      results.push({
        id: "natural-pet-bed-request-plans-and-resolves",
        repetition,
        content,
        passed: actual?.requestPlan?.intent === "action" &&
          !!plannedOperation &&
          actual?.parsed?.structured === true &&
          actual?.parsed?.protocolError === "" &&
          !!itemAdd &&
          resolution?.resolved?.ok === true &&
          resolution?.resolved?.group === "ItemDevices",
        actual,
      });
    }
  }

  const report = {
    summary: {
      version: await evaluate(client, "window.__misakaScriptVersion || 'unknown'"),
      repeats,
      runs: results.length,
      passed: results.filter(result => result.passed).length,
      failed: results.filter(result => !result.passed).length,
      modelCalls: results.length * 2,
      chatMessagesSent: 0,
      mutatingActionsCalled: false,
    },
    fixture,
    failures: results.filter(result => !result.passed),
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.summary.failed > 0 ? 1 : 0;
} finally {
  await evaluate(client, `(() => {
    const restore = window.__misakaRunnerRestore;
    window.__misakaTestLifecycle?.dispose?.("item-operation-suite-complete");
    delete window.__misakaTestLifecycle;
    if (restore?.hadPlanDebug) window.__misakaPlanDebug = restore.planDebug;
    else delete window.__misakaPlanDebug;
    if (restore?.hadScriptVersion) window.__misakaScriptVersion = restore.scriptVersion;
    else delete window.__misakaScriptVersion;
    delete window.__misakaRunnerRestore;
  })()`).catch(() => {});
  client.close();
}
