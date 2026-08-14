#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { evaluate, findMisakaTarget as findUserSession } from "./browser-session.mjs";

const playerMemberNumber = Number(process.env.MISAKA_PLAYER_MEMBER || 194331);
const repeatsArg = process.argv.find(arg => arg.startsWith("--repeats="));
const repeats = Math.max(1, Math.min(5, Number(repeatsArg?.split("=")[1]) || 3));
const chatUrl = new URL("../misaka-chat.js", import.meta.url);
const suiteUrl = new URL("./sticker-blue.browser.js", import.meta.url);

const { client } = await findUserSession();

try {
  // Ensure the local candidate starts with stickers enabled, then restore the
  // user's saved switch after the read-only suite.
  const savedSwitch = await evaluate(client,
    `localStorage.getItem("misaka_sticker_enabled")`);
  await evaluate(client, `localStorage.setItem("misaka_sticker_enabled", "true")`);
  try {
    await evaluate(client, `window.__misakaRunnerRestore = {
      hadPlanDebug: Object.prototype.hasOwnProperty.call(window, "__misakaPlanDebug"),
      planDebug: window.__misakaPlanDebug,
      hadScriptVersion: Object.prototype.hasOwnProperty.call(window, "__misakaScriptVersion"),
      scriptVersion: window.__misakaScriptVersion,
    }`);
    await evaluate(client, `window.__misakaNextBootstrapOptions = { mode: "test" }`);
    await evaluate(client, await readFile(chatUrl, "utf8"));
    await evaluate(client, await readFile(suiteUrl, "utf8"));
    const report = await evaluate(
      client,
      `window.__runMisakaStickerBlue(${JSON.stringify({ repeats })})`,
      true,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report?.summary?.failed > 0 ? 1 : 0;
  } finally {
    await evaluate(client, `(() => {
      const restore = window.__misakaRunnerRestore;
      window.__misakaTestLifecycle?.dispose?.("sticker-suite-complete");
      delete window.__misakaTestLifecycle;
      if (restore?.hadPlanDebug) window.__misakaPlanDebug = restore.planDebug;
      else delete window.__misakaPlanDebug;
      if (restore?.hadScriptVersion) window.__misakaScriptVersion = restore.scriptVersion;
      else delete window.__misakaScriptVersion;
      delete window.__misakaRunnerRestore;
    })()`).catch(() => {});
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
