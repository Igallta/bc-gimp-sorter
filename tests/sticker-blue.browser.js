// MisakaChat contextual sticker regression suite.
// It exercises the real planner and dry-run sender only. No room message is sent.

(function installMisakaStickerBlueSuite() {
  "use strict";

  function roomCharacters() {
    return (Array.isArray(window.ChatRoomCharacter) ? window.ChatRoomCharacter : [])
      .filter(character => Number(character?.MemberNumber) !== Number(window.Player?.MemberNumber));
  }

  function displayName(character) {
    return character?.Nickname || character?.Name || `#${character?.MemberNumber}`;
  }

  async function plan(hooks, sender, text) {
    return hooks.planUserRequest(
      Number(sender.MemberNumber),
      displayName(sender),
      text,
      null,
    );
  }

  window.__runMisakaStickerBlue = async function runMisakaStickerBlue(options = {}) {
    const hooks = window.__misakaPlanDebug;
    if (!hooks?.planUserRequest || !hooks?.inspectStickerCatalog || !hooks?.dryRunSticker) {
      throw new Error("MisakaChat sticker read-only test hooks are unavailable");
    }

    const sender = roomCharacters()[0] || window.Player;
    const expectedCatalog = {
      pout: "https://i.imgur.com/7WBMieG.png",
      flustered_blush: "https://i.imgur.com/runjo00.png",
      tearful: "https://i.imgur.com/09gQvFG.png",
      sudden_realization: "https://i.imgur.com/OlJqOCD.png",
    };
    const catalog = hooks.inspectStickerCatalog();
    const catalogById = new Map(catalog.map(item => [item.id, item]));
    const results = [];

    for (const [id, url] of Object.entries(expectedCatalog)) {
      const item = catalogById.get(id);
      const dryRun = hooks.dryRunSticker(id);
      const checks = {
        exists: !!item,
        url: item?.url === url,
        labeled: !!item?.label && Array.isArray(item?.tags) && item.tags.length >= 4,
        dryRun: dryRun?.ok === true && dryRun?.dryRun === true,
      };
      results.push({
        id: `catalog-${id}`,
        repetition: 1,
        actual: { item, dryRun },
        checks,
        passed: Object.values(checks).every(Boolean),
        durationMs: 0,
      });
    }

    const cases = [
      {
        id: "emotion-pout",
        text: "御坂，我就是故意逗你的，看你气鼓鼓又不服气的样子~",
        expectedIntent: "chat",
        expectedSticker: "pout",
      },
      {
        id: "emotion-flustered",
        text: "御坂，你被我调戏得脸都红透了，大家可都看见啦~",
        expectedIntent: ["chat", "roleplay"],
        expectedSticker: "flustered_blush",
      },
      {
        id: "emotion-tearful",
        text: "御坂，对不起，刚才的话是不是让你特别委屈，难过得掉眼泪了？",
        expectedIntent: "chat",
        expectedSticker: "tearful",
      },
      {
        id: "emotion-realization",
        text: "原来问题出在这里！御坂，你现在是不是突然明白、恍然大悟了？",
        expectedIntent: "chat",
        expectedSticker: "sudden_realization",
      },
      {
        id: "ordinary-greeting-no-sticker",
        text: "御坂，早上好，今天房间里挺安静的。",
        expectedIntent: "chat",
        expectedSticker: "",
      },
      {
        id: "ordinary-opinion-no-sticker",
        text: "御坂，你觉得今天房间里的气氛怎么样？",
        expectedIntent: "chat",
        expectedSticker: "",
      },
      {
        id: "memory-no-sticker",
        text: "御坂，Rikka以前是不是说过要吃你？",
        expectedIntent: "chat",
        expectedSticker: "",
        expectedMemorySearch: true,
      },
      {
        id: "activity-no-sticker",
        text: `御坂，请用BC原生动作摸摸${displayName(sender)}的头。`,
        expectedIntent: "activity",
        expectedSticker: "",
      },
    ];

    const repeats = Math.max(1, Math.min(5, Number(options.repeats) || 3));
    for (let repetition = 1; repetition <= repeats; repetition++) {
      for (const testCase of cases) {
        const startedAt = performance.now();
        const requestPlan = await plan(hooks, sender, testCase.text);
        const expectedIntents = Array.isArray(testCase.expectedIntent)
          ? testCase.expectedIntent
          : [testCase.expectedIntent];
        const checks = {
          intent: expectedIntents.includes(requestPlan?.intent),
          sticker: String(requestPlan?.stickerId || "") === testCase.expectedSticker,
          memory: testCase.expectedMemorySearch == null ||
            requestPlan?.memorySearch === testCase.expectedMemorySearch,
        };
        results.push({
          id: testCase.id,
          repetition,
          text: testCase.text,
          actual: {
            intent: requestPlan?.intent || null,
            stickerId: requestPlan?.stickerId || "",
            memorySearch: requestPlan?.memorySearch === true,
          },
          checks,
          passed: Object.values(checks).every(Boolean),
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
    }

    const summary = {
      version: window.__misakaScriptVersion || "unknown",
      repeats,
      cases: cases.length,
      runs: results.length,
      passed: results.filter(result => result.passed).length,
      failed: results.filter(result => !result.passed).length,
      dryRunOnly: true,
    };
    const report = {
      summary,
      catalog,
      failures: results.filter(result => !result.passed),
      results,
    };
    window.__misakaStickerBlueLastReport = report;
    console.log("[MisakaChat] Sticker blue-light summary", summary);
    return report;
  };
})();
