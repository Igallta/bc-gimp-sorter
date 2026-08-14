#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { evaluate, findMisakaTarget as findUserSession } from "./browser-session.mjs";

const playerMemberNumber = Number(process.env.MISAKA_PLAYER_MEMBER || 194331);
const repeatsArg = process.argv.find(arg => arg.startsWith("--repeats="));
const repeats = Math.max(1, Math.min(10, Number(repeatsArg?.split("=")[1]) || 3));
const idsArg = process.argv.find(arg => arg.startsWith("--ids="));
const ids = idsArg
  ? idsArg.split("=")[1].split(",").map(value => value.trim()).filter(Boolean)
  : null;
const chatUrl = new URL("../misaka-chat.js", import.meta.url);
const suiteUrl = new URL("./memory-blue.browser.js", import.meta.url);

const { client } = await findUserSession();

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
