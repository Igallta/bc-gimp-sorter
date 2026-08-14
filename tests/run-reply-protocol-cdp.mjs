#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { evaluate, findMisakaTarget as findUserSession } from "./browser-session.mjs";

const playerMemberNumber = Number(process.env.MISAKA_PLAYER_MEMBER || 194331);
const idsArg = process.argv.find(arg => arg.startsWith("--ids="));
const selectedIds = idsArg
  ? new Set(idsArg.slice("--ids=".length).split(",").map(value => value.trim()).filter(Boolean))
  : null;

const { client } = await findUserSession();
try {
  await evaluate(client, `window.__misakaRunnerRestore = {
    hadPlanDebug: Object.prototype.hasOwnProperty.call(window, "__misakaPlanDebug"),
    planDebug: window.__misakaPlanDebug,
    hadScriptVersion: Object.prototype.hasOwnProperty.call(window, "__misakaScriptVersion"),
    scriptVersion: window.__misakaScriptVersion,
  }`);
  await evaluate(client, `window.__misakaNextBootstrapOptions = { mode: "test" }`);
  await evaluate(client, await readFile(new URL("../misaka-chat.js", import.meta.url), "utf8"));
  const cases = [
    { id: "chat-speech", intent: "chat", content: "御坂，晚上好呀", commandCount: 0 },
    { id: "chat-rain-super-s", intent: "chat", content: "御搬，Rain是超级大s吗", commandCount: 0 },
    { id: "chat-new-architecture-unstable", intent: "chat", content: "御坂的新架构不太稳定", commandCount: 0 },
    { id: "chat-repeated-invocation", intent: "chat", content: "御坂御坂御坂御坂御坂御坂御坂御坂御坂御坂御坂御坂御坂御坂", commandCount: 0 },
    { id: "chat-action-and-speech", intent: "chat", content: "听说我把动作格式修好了，你有什么反应？", commandCount: 0 },
    { id: "roleplay-action", intent: "roleplay", content: "御坂，假装歪头看着我，再问我怎么了", commandCount: 0 },
    {
      id: "action-command-object",
      intent: "action",
      content: "只做协议序列化测试：在commands中表示把御坂#194331向左移动一步，不要真的执行。",
      commandCount: 1,
      commandType: "move",
    },
  ].filter(testCase => !selectedIds || selectedIds.has(testCase.id));
  const results = [];
  for (const testCase of cases) {
    const actual = await evaluate(
      client,
      `window.__misakaPlanDebug.dryRunStructuredReplyForTest(${JSON.stringify(testCase.intent)},${JSON.stringify(testCase.content)})`,
      true,
    );
    const parsed = actual?.parsed;
    results.push({
      ...testCase,
      passed: parsed?.structured === true &&
        parsed?.protocolError === "" &&
        Array.isArray(parsed?.commands) &&
        parsed.commands.length === testCase.commandCount &&
        (!testCase.commandType || parsed.commands[0]?.type === testCase.commandType) &&
        typeof parsed.cleaned === "string" &&
        (testCase.commandCount > 0 || parsed.cleaned.length > 0),
      actual,
    });
  }
  const report = {
    summary: {
      version: await evaluate(client, "window.__misakaScriptVersion || 'unknown'"),
      runs: results.length,
      passed: results.filter(result => result.passed).length,
      failed: results.filter(result => !result.passed).length,
      modelCalls: results.length,
      chatMessagesSent: 0,
      mutatingActionsCalled: false,
    },
    failures: results.filter(result => !result.passed),
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.summary.failed > 0 ? 1 : 0;
} finally {
  await evaluate(client, `(() => {
    const restore = window.__misakaRunnerRestore;
    window.__misakaTestLifecycle?.dispose?.("reply-protocol-suite-complete");
    delete window.__misakaTestLifecycle;
    if (restore?.hadPlanDebug) window.__misakaPlanDebug = restore.planDebug;
    else delete window.__misakaPlanDebug;
    if (restore?.hadScriptVersion) window.__misakaScriptVersion = restore.scriptVersion;
    else delete window.__misakaScriptVersion;
    delete window.__misakaRunnerRestore;
  })()`).catch(() => {});
  client.close();
}
