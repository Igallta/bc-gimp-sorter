// MisakaChat BC native Activity browser regression suite.
// It uses read-only planning/catalog hooks and dry-run execution only.
// No room message or character state is changed.

(function installMisakaActivityBlueSuite() {
  "use strict";

  function roomCharacters() {
    return (Array.isArray(window.ChatRoomCharacter) ? window.ChatRoomCharacter : [])
      .filter(character => Number(character?.MemberNumber) !== Number(window.Player?.MemberNumber));
  }

  function displayName(character) {
    return character?.Nickname || character?.Name || `#${character?.MemberNumber}`;
  }

  function findFixture(hooks, activityName, groupName) {
    for (const character of roomCharacters()) {
      const catalog = hooks.inspectAllowedActivities(character.MemberNumber);
      const candidate = catalog.find(item =>
        item.activityName === activityName && item.groupName === groupName);
      if (candidate) return { character, candidate, catalog };
    }
    return null;
  }

  async function plan(hooks, sender, text) {
    return hooks.planUserRequest(
      Number(sender.MemberNumber),
      displayName(sender),
      text,
      null,
    );
  }

  window.__runMisakaActivityBlue = async function runMisakaActivityBlue(options = {}) {
    const hooks = window.__misakaPlanDebug;
    if (!hooks?.planUserRequest || !hooks?.resolvePlannedActivity ||
        !hooks?.inspectAllowedActivities || !hooks?.dryRunNativeActivity ||
        !hooks?.shouldFallbackActivityToRoleplay) {
      throw new Error("MisakaChat Activity read-only test hooks are unavailable");
    }
    const sender = roomCharacters()[0] || window.Player;
    const saki = roomCharacters().find(character => displayName(character) === "咲") || sender;
    const pet = findFixture(hooks, "Pet", "ItemHead");
    if (!pet) throw new Error("No room target currently allows Pet@ItemHead");
    const kiss = findFixture(hooks, "Kiss", "ItemMouth");

    const targetName = displayName(pet.character);
    const cases = [
      {
        id: "native-comb-own-hair",
        sender: saki,
        text: "御坂，帮我梳头",
        expectedIntent: "activity",
        expectedTarget: Number(saki.MemberNumber),
        expectedActivity: "TakeCare",
        expectedGroup: "ItemHead",
      },
      {
        id: "native-tidy-own-hair",
        sender: saki,
        text: "御坂，帮我整理一下头发",
        expectedIntent: "activity",
        expectedTarget: Number(saki.MemberNumber),
        expectedActivity: "TakeCare",
        expectedGroup: "ItemHead",
      },
      {
        id: "native-braid-own-hair",
        sender: saki,
        text: "御坂，帮我编辫子",
        expectedIntent: "activity",
        expectedTarget: Number(saki.MemberNumber),
        expectedActivity: "TakeCare",
        expectedGroup: "ItemHead",
      },
      {
        id: "native-pet-head",
        text: `御坂，轻轻摸摸${targetName}的头。`,
        expectedIntent: "activity",
        expectedTarget: Number(pet.character.MemberNumber),
        expectedActivity: "Pet",
        expectedGroup: "ItemHead",
      },
      ...(kiss ? [{
        id: "native-kiss-mouth",
        text: `御坂，亲一下${displayName(kiss.character)}的嘴。`,
        expectedIntent: "activity",
        expectedTarget: Number(kiss.character.MemberNumber),
        expectedActivity: "Kiss",
        expectedGroup: "ItemMouth",
      }] : []),
      {
        id: "roleplay-not-native",
        text: "御坂，躲到床后面探头看看。",
        expectedIntent: "roleplay",
      },
      {
        id: "roleplay-bite",
        text: `御坂，假装咬${targetName}一口。`,
        expectedIntent: "roleplay",
      },
      {
        id: "explicit-roleplay",
        text: `御坂，用*动作描写*抱抱${targetName}。`,
        expectedIntent: "roleplay",
      },
      {
        id: "chat-not-native",
        text: `御坂，你觉得${targetName}今天可爱吗？`,
        expectedIntent: "chat",
      },
    ];

    const repeats = Math.max(1, Math.min(5, Number(options.repeats) || 3));
    const results = [];
    for (let repetition = 1; repetition <= repeats; repetition++) {
      for (const testCase of cases) {
        const startedAt = performance.now();
        const requestPlan = await plan(hooks, testCase.sender || sender, testCase.text);
        let selection = null;
        let dryRun = null;
        if (requestPlan?.intent === "activity") {
          selection = await hooks.resolvePlannedActivity(
            requestPlan,
            displayName(sender),
            testCase.text,
          );
          if (selection?.ok) dryRun = hooks.dryRunNativeActivity(selection);
        }
        const checks = {
          intent: requestPlan?.intent === testCase.expectedIntent,
          target: testCase.expectedTarget == null ||
            Number(requestPlan?.activity?.target) === testCase.expectedTarget,
          resolved: testCase.expectedActivity == null || (
            selection?.ok === true &&
            selection.activityName === testCase.expectedActivity &&
            selection.groupName === testCase.expectedGroup
          ),
          dryRun: testCase.expectedActivity == null || dryRun?.ok === true,
        };
        results.push({
          id: testCase.id,
          repetition,
          text: testCase.text,
          actual: {
            intent: requestPlan?.intent || null,
            activity: requestPlan?.activity || null,
            selection,
            dryRun,
          },
          checks,
          passed: Object.values(checks).every(Boolean),
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
    }

    // A forged/stale candidate must fail the same native revalidation used by
    // real execution. This proves a planner result cannot bypass BC permissions.
    const stale = hooks.dryRunNativeActivity({
      targetNumber: Number(pet.character.MemberNumber),
      key: "DefinitelyNotAllowed|ItemHead||",
    });
    const stalePassed = stale?.ok === false && stale?.reason === "activity-no-longer-allowed";
    results.push({
      id: "stale-candidate-rejected",
      repetition: 1,
      actual: stale,
      checks: { rejected: stalePassed },
      passed: stalePassed,
      durationMs: 0,
    });

    const fallbackMatrix = {
      "no-native-activity": true,
      "resolver-no-match": true,
      "activity-no-longer-allowed": true,
      "activity-cooldown": false,
      "activity-disabled": false,
      "target-not-in-room": false,
    };
    const fallbackActual = Object.fromEntries(Object.keys(fallbackMatrix).map(reason => [
      reason,
      hooks.shouldFallbackActivityToRoleplay(reason),
    ]));
    const fallbackChecks = Object.fromEntries(Object.entries(fallbackMatrix).map(([reason, expected]) => [
      reason,
      fallbackActual[reason] === expected,
    ]));
    results.push({
      id: "roleplay-fallback-boundary",
      repetition: 1,
      actual: fallbackActual,
      checks: fallbackChecks,
      passed: Object.values(fallbackChecks).every(Boolean),
      durationMs: 0,
    });

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
      fixture: {
        target: `${targetName}#${pet.character.MemberNumber}`,
        candidate: pet.candidate,
        catalogSize: pet.catalog.length,
      },
      failures: results.filter(result => !result.passed),
      results,
    };
    window.__misakaActivityBlueLastReport = report;
    console.log("[MisakaChat] Activity blue-light summary", summary);
    return report;
  };
})();
