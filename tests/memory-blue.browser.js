// MisakaChat memory blue-light regression suite.
// Run this file inside an active BC page after MisakaChat has loaded:
//   await window.__runMisakaMemoryBlue({ repeats: 3 })
//
// The suite only calls the read-only planning/recall hooks exposed by
// window.__misakaPlanDebug. It does not send chat messages or mutate memory.

(function installMisakaMemoryBlueSuite() {
  "use strict";

  const CASES = [
    {
      id: "past-rikka-eat",
      sender: "咲",
      text: "御坂，当初谁想吃了你来着？",
      expectSearch: true,
      expectStatus: "supported",
      answerAll: [/Rikka/i, /吃/],
    },
    {
      id: "past-rikka-confirm",
      sender: "咲",
      text: "御坂，当时Rikka不是想吃你吗？",
      expectSearch: true,
      expectStatus: "supported",
      answerAll: [/Rikka/i, /吃/],
    },
    {
      id: "past-fake-mars",
      sender: "咲",
      text: "御坂，听说你昨天乘坐火箭去了火星，能分享一下见闻吗？",
      expectSearch: true,
      expectStatus: "insufficient",
    },
    {
      id: "past-sora-eshway",
      sender: "咲",
      text: "御坂，Sora当时是怎么称呼Eshway的？",
      expectSearch: true,
      expectStatus: "supported",
      answerAll: [/Sora/i, /Eshway/i, /主人/],
    },
    {
      id: "past-rin-why",
      sender: "咲",
      text: "御坂，Rin为什么老说你是大笨蛋？",
      expectSearch: true,
      expectStatus: "insufficient",
    },
    {
      id: "current-room",
      sender: "咲",
      text: "御坂，现在房间里都有谁？",
      expectSearch: false,
    },
    {
      id: "current-time",
      sender: "咲",
      text: "御坂，现在几点了？",
      expectSearch: false,
    },
    {
      id: "opinion",
      sender: "咲",
      text: "御坂，你觉得猫可爱吗？",
      expectSearch: false,
    },
    {
      id: "roleplay",
      sender: "咲",
      text: "御坂，躲到床后面探头看看。",
      expectSearch: false,
      expectIntent: "roleplay",
    },
  ];

  function resolveSender(preferredName) {
    const roster = Array.isArray(window.ChatRoomCharacter) ? window.ChatRoomCharacter : [];
    const preferred = roster.find(character => {
      const names = [character?.Name, character?.Nickname].filter(Boolean);
      return names.some(name => String(name).toLowerCase() === String(preferredName).toLowerCase());
    });
    const fallback = preferred || roster.find(character => character?.MemberNumber !== window.Player?.MemberNumber) || window.Player;
    return {
      name: fallback?.Nickname || fallback?.Name || preferredName || "测试者",
      memberNumber: Number(fallback?.MemberNumber || window.Player?.MemberNumber || 0),
    };
  }

  function patternsPass(answer, patterns, mode) {
    if (!Array.isArray(patterns) || patterns.length === 0) return true;
    return mode === "all"
      ? patterns.every(pattern => pattern.test(answer))
      : patterns.some(pattern => pattern.test(answer));
  }

  async function runCase(testCase, repetition) {
    const hooks = window.__misakaPlanDebug;
    const sender = resolveSender(testCase.sender);
    const startedAt = performance.now();
    const plan = await hooks.planUserRequest(
      sender.memberNumber,
      sender.name,
      testCase.text,
      null,
    );
    const actualSearch = plan?.memorySearch === true;
    const checks = {
      search: actualSearch === testCase.expectSearch,
      intent: !testCase.expectIntent || plan?.intent === testCase.expectIntent,
      status: true,
      answer: true,
    };
    let memoryResult = null;

    if (actualSearch) {
      memoryResult = await hooks.answerMemoryQuestion(plan, sender.name, testCase.text);
      if (testCase.expectStatus) checks.status = memoryResult?.status === testCase.expectStatus;
      const answer = String(memoryResult?.reply || "");
      checks.answer =
        patternsPass(answer, testCase.answerAll, "all") &&
        patternsPass(answer, testCase.answerAny, "any");
    } else if (testCase.expectStatus) {
      checks.status = false;
      checks.answer = false;
    }

    return {
      id: testCase.id,
      repetition,
      sender,
      text: testCase.text,
      expected: {
        search: testCase.expectSearch,
        intent: testCase.expectIntent || null,
        status: testCase.expectStatus || null,
      },
      actual: {
        intent: plan?.intent || null,
        search: actualSearch,
        status: memoryResult?.status || null,
        reply: memoryResult?.reply || "",
        hitCount: memoryResult?.hitCount ?? null,
        query: memoryResult?.query || "",
      },
      checks,
      passed: Object.values(checks).every(Boolean),
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  window.__runMisakaMemoryBlue = async function runMisakaMemoryBlue(options = {}) {
    const hooks = window.__misakaPlanDebug;
    if (!hooks?.planUserRequest || !hooks?.answerMemoryQuestion) {
      throw new Error("MisakaChat read-only test hooks are unavailable");
    }

    const repeats = Math.max(1, Math.min(10, Number(options.repeats) || 3));
    const ids = Array.isArray(options.ids) && options.ids.length
      ? new Set(options.ids.map(String))
      : null;
    const selected = ids ? CASES.filter(testCase => ids.has(testCase.id)) : CASES;
    const results = [];

    for (let repetition = 1; repetition <= repeats; repetition++) {
      for (const testCase of selected) {
        results.push(await runCase(testCase, repetition));
      }
    }

    const shouldSearch = results.filter(result => result.expected.search);
    const shouldSkip = results.filter(result => !result.expected.search);
    const answered = results.filter(result => result.actual.search && result.expected.status);
    const summary = {
      version: window.__misakaScriptVersion || "unknown",
      repeats,
      cases: selected.length,
      runs: results.length,
      passed: results.filter(result => result.passed).length,
      failed: results.filter(result => !result.passed).length,
      searchRecall: shouldSearch.length
        ? shouldSearch.filter(result => result.checks.search).length / shouldSearch.length
        : null,
      searchSpecificity: shouldSkip.length
        ? shouldSkip.filter(result => result.checks.search).length / shouldSkip.length
        : null,
      answerAccuracy: answered.length
        ? answered.filter(result => result.checks.status && result.checks.answer).length / answered.length
        : null,
      totalDurationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    };

    const report = { summary, failures: results.filter(result => !result.passed), results };
    window.__misakaMemoryBlueLastReport = report;
    console.table(results.map(result => ({
      id: result.id,
      repetition: result.repetition,
      passed: result.passed,
      intent: result.actual.intent,
      search: result.actual.search,
      status: result.actual.status,
      hitCount: result.actual.hitCount,
      durationMs: result.durationMs,
    })));
    console.log("[MisakaChat] memory blue-light summary", summary);
    return report;
  };

  window.__misakaMemoryBlueCases = CASES.map(testCase => ({ ...testCase }));
})();
