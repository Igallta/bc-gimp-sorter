#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { evaluate, findMisakaTarget as findUserSession } from "./browser-session.mjs";

const playerMemberNumber = Number(process.env.MISAKA_PLAYER_MEMBER || 194331);
const repeatsArg = process.argv.find(arg => arg.startsWith("--repeats="));
const repeats = Math.max(1, Math.min(5, Number(repeatsArg?.split("=")[1]) || 3));
const loadOnly = process.argv.includes("--load-only");
const chatUrl = new URL("../misaka-chat.js", import.meta.url);
const suiteUrl = new URL("./activity-blue.browser.js", import.meta.url);

const { client } = await findUserSession();

try {
  // Normal regression runs use a side-effect-free test lifecycle: no IDB
  // memory load, socket hook, idle timer, or live runtime replacement.
  if (!loadOnly) {
    await evaluate(client, `window.__misakaRunnerRestore = {
      hadPlanDebug: Object.prototype.hasOwnProperty.call(window, "__misakaPlanDebug"),
      planDebug: window.__misakaPlanDebug,
      hadScriptVersion: Object.prototype.hasOwnProperty.call(window, "__misakaScriptVersion"),
      scriptVersion: window.__misakaScriptVersion,
    }`);
    await evaluate(client, `window.__misakaNextBootstrapOptions = { mode: "test" }`);
  }
  await evaluate(client, await readFile(chatUrl, "utf8"));
  if (loadOnly) await new Promise(resolve => setTimeout(resolve, 2500));
  if (loadOnly) {
    await evaluate(client, "delete window.__misakaApiDebug");
    const version = await evaluate(client, "window.__misakaScriptVersion || 'unknown'");
    process.stdout.write(`${JSON.stringify({ version, playerMemberNumber, loadOnly: true })}\n`);
    process.exitCode = 0;
  } else {
    await evaluate(client, await readFile(suiteUrl, "utf8"));
    const report = await evaluate(
      client,
      `window.__runMisakaActivityBlue(${JSON.stringify({ repeats })})`,
      true,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report?.summary?.failed > 0 ? 1 : 0;
  }
} finally {
  if (!loadOnly) {
    await evaluate(client, `(() => {
      const restore = window.__misakaRunnerRestore;
      window.__misakaTestLifecycle?.dispose?.("activity-suite-complete");
      delete window.__misakaTestLifecycle;
      if (restore?.hadPlanDebug) window.__misakaPlanDebug = restore.planDebug;
      else delete window.__misakaPlanDebug;
      if (restore?.hadScriptVersion) window.__misakaScriptVersion = restore.scriptVersion;
      else delete window.__misakaScriptVersion;
      delete window.__misakaRunnerRestore;
    })()`).catch(() => {});
  }
  client.close();
}
