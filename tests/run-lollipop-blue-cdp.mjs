#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const cdpBase = process.env.MISAKA_CDP_URL || "http://127.0.0.1:9222";
const playerMemberNumber = Number(process.env.MISAKA_PLAYER_MEMBER || 194331);
const repeats = Math.max(1, Math.min(10, Number(process.argv.find(arg => arg.startsWith("--repeats="))?.split("=")[1]) || 1));
const helpersOnly = process.argv.includes("--helpers-only");

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
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function findMisakaTarget() {
  const targets = await (await fetch(`${cdpBase}/json`)).json();
  for (const target of targets) {
    if (target.type !== "page" || !/bondage-(?:europe|asia)\.com/i.test(target.url || "") ||
        !target.webSocketDebuggerUrl) continue;
    const client = await connectCdp(target.webSocketDebuggerUrl);
    if (await evaluate(client, "Number(window.Player?.MemberNumber || 0)") === playerMemberNumber) return client;
    client.close();
  }
  throw new Error(`No active Misaka #${playerMemberNumber} page found`);
}

const client = await findMisakaTarget();
try {
  await evaluate(client, `window.__misakaLollipopRunnerRestore = {
    hadPlanDebug: Object.prototype.hasOwnProperty.call(window, "__misakaPlanDebug"),
    planDebug: window.__misakaPlanDebug,
    hadScriptVersion: Object.prototype.hasOwnProperty.call(window, "__misakaScriptVersion"),
    scriptVersion: window.__misakaScriptVersion,
  }`);
  await evaluate(client, "window.__misakaNextBootstrapOptions = { mode: 'test' }");
  await evaluate(client, await readFile(new URL("../misaka-chat.js", import.meta.url), "utf8"));
  const fixture = await evaluate(client, `(() => {
    const chars = window.ChatRoomCharacter || [];
    const byName = value => chars.find(c => [c.Name, c.Nickname].some(name =>
      String(name || "").trim().toLowerCase() === value.toLowerCase()));
    const pick = value => { const c = byName(value); return c && { name: c.Nickname || c.Name, memberNumber: Number(c.MemberNumber) }; };
    const lollipop = (window.Asset || []).find(a => a?.Group?.Name === "ItemHandheld" &&
      /棒棒糖|lollipop/i.test([a.Name, a.Description].join(" ")));
    return { rikka: pick("Rikka"), maple: pick("殘楓"), rin: pick("Rin"), saki: pick("咲"),
      lollipop: lollipop && { name: lollipop.Name, group: lollipop.Group.Name } };
  })()`);
  if (!fixture.lollipop) {
    throw new Error(`Missing fixture: ${JSON.stringify(fixture)}`);
  }
  const helperDiagnostics = await evaluate(client, `({
    begins: window.__misakaPlanDebug.beginsWithMisakaInvocationForTest("御搬，给咲点吃的"),
    folded: window.__misakaPlanDebug.foldIdentityTextForTest("御搬，给殘楓点吃的"),
    saki: window.__misakaPlanDebug.findUniqueMentionedRoomCharacterForTest("御搬，给咲点吃的"),
    maple: window.__misakaPlanDebug.findUniqueMentionedRoomCharacterForTest("御搬，给残枫点吃的")
  })`);

  const cases = helpersOnly ? [] : [
    ...(fixture.rikka ? [{ id: "traditional-give-rikka-lollipop", sender: fixture.saki || fixture.rikka,
      content: "給rikka一根棒棒糖", target: fixture.rikka.memberNumber, exact: true },
    { id: "traditional-give-me-lollipop-in-hand", sender: fixture.rikka,
      content: "御坂，你要給我棒棒糖，要給到我的手裡呀", target: fixture.rikka.memberNumber, exact: true }] : []),
    ...(fixture.maple ? [{ id: "give-maple-food", sender: fixture.rin || fixture.maple,
      content: "御搬，给残枫点吃的", target: fixture.maple.memberNumber, exact: false },
    { id: "traditional-give-maple-lollipop", sender: fixture.saki || fixture.maple,
      content: "給残枫一根棒棒糖", target: fixture.maple.memberNumber, exact: true }] : []),
    { id: "give-saki-food", sender: fixture.rin || fixture.maple,
      content: "御搬，给咲点吃的", target: fixture.saki?.memberNumber, exact: false },
    ...(fixture.rin ? [{ id: "replace-expired-self-lollipop", sender: fixture.rin,
      content: "御搬，你手里的棒棒糖过期了，换个别的", target: playerMemberNumber,
      mode: "replace" }] : []),
  ].filter(test => Number.isFinite(test.target));
  const results = [];
  if (!helpersOnly) {
  for (let repetition = 1; repetition <= repeats; repetition++) {
    for (const test of cases) {
      const actual = await evaluate(client,
        `window.__misakaPlanDebug.dryRunConversationForTest(${test.sender.memberNumber},` +
        `${JSON.stringify(test.sender.name)},${JSON.stringify(test.content)})`, true);
      const command = actual?.filtered?.allowed?.find(candidate => candidate?.type === "itemadd" &&
        Number(candidate?.memberNumber) === test.target &&
        (!test.exact || candidate?.item === fixture.lollipop.name));
      const resolution = actual?.resolutions?.find(entry => entry?.command === command ||
        (entry?.command?.type === "itemadd" && Number(entry?.command?.memberNumber) === test.target));
      const replacementDelete = actual?.filtered?.allowed?.find(candidate =>
        candidate?.type === "itemdel" && Number(candidate?.memberNumber) === test.target &&
        candidate?.item === fixture.lollipop.name);
      const passed = test.mode === "replace"
        ? actual?.requestPlan?.intent === "action" && !!replacementDelete && !!command &&
          resolution?.resolved?.ok === true && resolution?.resolved?.group === "ItemHandheld"
        : actual?.requestPlan?.intent === "action" && !!command &&
          resolution?.resolved?.ok === true && resolution?.resolved?.group === "ItemHandheld";
      results.push({ ...test, repetition, passed,
        actual });
    }
  }
  }
  const report = { fixture, summary: { runs: results.length,
    passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length,
    chatMessagesSent: 0, mutatingActionsCalled: false }, helperDiagnostics, results };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.summary.failed ? 1 : 0;
} finally {
  await evaluate(client, `(() => {
    const restore = window.__misakaLollipopRunnerRestore;
    window.__misakaTestLifecycle?.dispose?.("lollipop-suite-complete");
    delete window.__misakaTestLifecycle;
    if (restore?.hadPlanDebug) window.__misakaPlanDebug = restore.planDebug;
    else delete window.__misakaPlanDebug;
    if (restore?.hadScriptVersion) window.__misakaScriptVersion = restore.scriptVersion;
    else delete window.__misakaScriptVersion;
    delete window.__misakaLollipopRunnerRestore;
  })()`).catch(() => {});
  client.close();
}
