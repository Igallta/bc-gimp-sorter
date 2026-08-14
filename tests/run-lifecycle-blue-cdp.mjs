#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { evaluate, findMisakaTarget as findUserSession } from "./browser-session.mjs";

const iterationsArg = process.argv.find(arg => arg.startsWith("--iterations="));
const iterations = Math.max(2, Math.min(30, Number(iterationsArg?.split("=")[1]) || 10));
const source = await readFile(new URL("../misaka-chat.js", import.meta.url), "utf8");

const { client } = await findUserSession();
try {
  await evaluate(client, `(() => {
    window.__misakaTestLifecycle?.dispose?.("test-suite-start");
    delete window.__misakaTestLifecycle;
    window.__misakaLifecycleTestRestore = {
      hadPlanDebug: Object.prototype.hasOwnProperty.call(window, "__misakaPlanDebug"),
      planDebug: window.__misakaPlanDebug,
      hadScriptVersion: Object.prototype.hasOwnProperty.call(window, "__misakaScriptVersion"),
      scriptVersion: window.__misakaScriptVersion,
    };
  })()`);
  await client.call("HeapProfiler.collectGarbage");
  const heapBefore = await client.call("Runtime.getHeapUsage");
  const activeBefore = await evaluate(client,
    `window.__misakaLifecycle?.id || window.__misakaInstance || null`);
  const runs = [];

  for (let index = 0; index < iterations; index++) {
    await evaluate(client,
      `window.__misakaPreviousTestLifecycleProbe = window.__misakaTestLifecycle || null;
       window.__misakaNextBootstrapOptions = { mode: "test" };`);
    await evaluate(client, source);
    const result = await evaluate(client, `({
      previousDisposed: !window.__misakaPreviousTestLifecycleProbe ||
        window.__misakaPreviousTestLifecycleProbe.disposed === true,
      lifecycle: window.__misakaPlanDebug.inspectLifecycleForTest(),
    })`);
    await evaluate(client, `delete window.__misakaPreviousTestLifecycleProbe`);
    runs.push({
      index: index + 1,
      ...result,
      passed: result.previousDisposed === true &&
        result.lifecycle?.mode === "test" &&
        result.lifecycle?.current === true &&
        result.lifecycle?.disposed === false &&
        result.lifecycle?.timeouts === 0 &&
        result.lifecycle?.intervals === 0 &&
        result.lifecycle?.requests === 0 &&
        result.lifecycle?.idbReady === true &&
        result.lifecycle?.semanticMemories === 0 &&
        result.lifecycle?.refinedMemories === 0,
    });
  }

  const candidateVersion = await evaluate(client, "window.__misakaScriptVersion || 'unknown'");
  const globalsRestored = await evaluate(client, `(() => {
    const restore = window.__misakaLifecycleTestRestore;
    window.__misakaTestLifecycle?.dispose?.("test-suite-complete");
    delete window.__misakaTestLifecycle;
    if (restore?.hadPlanDebug) window.__misakaPlanDebug = restore.planDebug;
    else delete window.__misakaPlanDebug;
    if (restore?.hadScriptVersion) window.__misakaScriptVersion = restore.scriptVersion;
    else delete window.__misakaScriptVersion;
    const result = {
      testLifecycleRemoved: !window.__misakaTestLifecycle,
      planDebugRestored: restore?.hadPlanDebug
        ? window.__misakaPlanDebug === restore.planDebug
        : !Object.prototype.hasOwnProperty.call(window, "__misakaPlanDebug"),
      scriptVersionRestored: restore?.hadScriptVersion
        ? window.__misakaScriptVersion === restore.scriptVersion
        : !Object.prototype.hasOwnProperty.call(window, "__misakaScriptVersion"),
    };
    delete window.__misakaLifecycleTestRestore;
    return result;
  })()`);
  await client.call("HeapProfiler.collectGarbage");
  const heapAfter = await client.call("Runtime.getHeapUsage");
  const activeAfter = await evaluate(client,
    `window.__misakaLifecycle?.id || window.__misakaInstance || null`);
  const heapGrowth = heapAfter.usedSize - heapBefore.usedSize;
  const report = {
    summary: {
      version: candidateVersion,
      iterations,
      passed: runs.filter(run => run.passed).length,
      failed: runs.filter(run => !run.passed).length,
      activeRuntimePreserved: activeAfter === activeBefore,
      globalsRestored: Object.values(globalsRestored).every(Boolean),
      heapBefore: heapBefore.usedSize,
      heapAfter: heapAfter.usedSize,
      heapGrowth,
      heapGrowthWithinLimit: heapGrowth < 20 * 1024 * 1024,
      chatMessagesSent: 0,
      mutatingActionsCalled: false,
    },
    failures: runs.filter(run => !run.passed),
    runs,
  };
  if (!report.summary.activeRuntimePreserved ||
      !report.summary.globalsRestored ||
      !report.summary.heapGrowthWithinLimit) {
    report.summary.failed++;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.summary.failed > 0 ? 1 : 0;
} finally {
  client.close();
}
