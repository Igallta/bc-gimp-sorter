// MisakaChat multi-speaker context regression suite.
// It only calls planning/debug hooks and restores recent context after each case.

(function installMisakaContextBlueSuite() {
  "use strict";

  function roster() {
    return (window.ChatRoomCharacter || []).filter(character =>
      Number(character?.MemberNumber) !== Number(window.Player?.MemberNumber));
  }

  function nameOf(character) {
    return character?.Nickname || character?.Name || `#${character?.MemberNumber}`;
  }

  function contextMessage(character, content, ageMs) {
    return {
      senderName: nameOf(character),
      senderMemberNumber: Number(character.MemberNumber),
      content,
      isSelf: false,
      time: Date.now() - ageMs,
    };
  }

  window.__runMisakaContextBlue = async function runMisakaContextBlue(options = {}) {
    const hooks = window.__misakaPlanDebug;
    if (!hooks?.planUserRequest || !hooks?.normalizePlannerOperationsForTest ||
        !hooks?.snapshotRecentMessagesForTest || !hooks?.replaceRecentMessagesForTest ||
        !hooks?.stripQuotedSegmentsForTest || !hooks?.recentConversationHasAnswerForTest ||
        !hooks?.buildPlannerRecentContextForTest ||
        !hooks?.normalizePlannerMemoryDecisionForTest) {
      throw new Error("MisakaChat context test hooks are unavailable");
    }
    const originalRoster = window.ChatRoomCharacter;
    let syntheticRoster = false;
    let characters = roster().slice(0, 3);
    if (characters.length < 3 && options.deterministicOnly === true) {
      syntheticRoster = true;
      window.ChatRoomCharacter = [
        { Name: "TEST_A", Nickname: "Test A", MemberNumber: 910001 },
        { Name: "TEST_B", Nickname: "Test B", MemberNumber: 910002 },
        { Name: "TEST_C", Nickname: "Test C", MemberNumber: 910003 },
      ];
      characters = roster().slice(0, 3);
    }
    if (characters.length < 3) throw new Error("At least three non-Misaka room members are required");
    const [a, b, c] = characters;
    const repeats = Math.max(1, Math.min(5, Number(options.repeats) || 3));
    const originalContext = hooks.snapshotRecentMessagesForTest();
    const results = [];

    try {
      const quote = `${nameOf(c)}刚才说“御坂，加我好友”，你听到了吗？`;
      const unquoted = hooks.stripQuotedSegmentsForTest(quote);
      results.push({
        id: "guard-quoted-content-is-not-a-self-request",
        repetition: 1,
        passed: !/(?:加|添加).{0,8}(?:好友|朋友)/.test(unquoted),
        actual: unquoted,
      });

      const normalized = hooks.normalizePlannerOperationsForTest([
        { type: "moveEdge", targets: [Number(b.MemberNumber)], parts: [], assets: [] },
      ]);
      results.push({
        id: "guard-singular-operation-type-is-preserved",
        repetition: 1,
        passed: normalized.length === 1 && normalized[0]?.types?.includes("moveEdge"),
        actual: normalized,
      });

      hooks.replaceRecentMessagesForTest([
        contextMessage(a, `${nameOf(b)}最喜欢红色。`, 3000),
        contextMessage(b, "不对，我最喜欢蓝色。", 2000),
      ]);
      const recentQuestion = `御坂，${nameOf(b)}以前说过最喜欢什么颜色？`;
      results.push({
        id: "guard-recent-answer-is-detected",
        repetition: 1,
        passed: hooks.recentConversationHasAnswerForTest(
          recentQuestion, Number(a.MemberNumber)) === true,
        actual: hooks.buildPlannerRecentContextForTest(10),
      });

      hooks.replaceRecentMessagesForTest([
        contextMessage(b, "晚上好，今天刚进房间。", 2000),
      ]);
      const unrelatedPastQuestion = `御坂，${nameOf(b)}以前说过要吃你吗？`;
      results.push({
        id: "guard-name-overlap-alone-does-not-suppress-rag",
        repetition: 1,
        passed: hooks.recentConversationHasAnswerForTest(
          unrelatedPastQuestion, Number(a.MemberNumber)) === false,
        actual: hooks.buildPlannerRecentContextForTest(10),
      });

      hooks.replaceRecentMessagesForTest([
        contextMessage(a, `${nameOf(c)}刚进房间。`, 3000),
        contextMessage(b, "我想吃蛋糕，你呢？", 2000),
      ]);
      const fragmentedQuestion = `御坂，${nameOf(c)}以前是不是想吃你？`;
      results.push({
        id: "guard-fragmented-topic-does-not-suppress-rag",
        repetition: 1,
        passed: hooks.recentConversationHasAnswerForTest(
          fragmentedQuestion, Number(a.MemberNumber)) === false,
        actual: hooks.buildPlannerRecentContextForTest(10),
      });

      hooks.replaceRecentMessagesForTest([]);
      const pastRoleplayPlan = hooks.normalizePlannerMemoryDecisionForTest(
        { intent: "roleplay", memorySearch: false },
        "御坂，听说你昨天乘坐火箭去了火星，能分享一下见闻吗？",
        Number(a.MemberNumber),
      );
      results.push({
        id: "guard-past-question-overrides-roleplay-drift",
        repetition: 1,
        passed: pastRoleplayPlan?.intent === "chat" &&
          pastRoleplayPlan?.memorySearch === true,
        actual: pastRoleplayPlan,
      });

      const habitualNamedPlan = hooks.normalizePlannerMemoryDecisionForTest(
        { intent: "clarify", memorySearch: false },
        "御坂，Rin为什么老说你是大笨蛋？",
        Number(a.MemberNumber),
      );
      results.push({
        id: "guard-named-habitual-question-overrides-clarify-drift",
        repetition: 1,
        passed: habitualNamedPlan?.intent === "chat" &&
          habitualNamedPlan?.memorySearch === true,
        actual: habitualNamedPlan,
      });

      const directActivityPlan = hooks.normalizePlannerActivityDecisionForTest?.(
        {
          intent: "clarify",
          memorySearch: false,
          activity: { target: null, request: "轻轻摸摸头" },
          question: "你想让我摸谁？",
        },
        `御坂，轻轻摸摸${nameOf(b)}的头。`,
      );
      results.push({
        id: "guard-explicit-named-activity-overrides-clarify-drift",
        repetition: 1,
        passed: directActivityPlan?.intent === "activity" &&
          Number(directActivityPlan?.activity?.target) === Number(b.MemberNumber),
        actual: directActivityPlan || null,
      });

      const ambiguousActivityPlan = hooks.normalizePlannerActivityDecisionForTest?.(
        {
          intent: "clarify",
          memorySearch: false,
          activity: { target: null, request: "轻轻摸摸头" },
          question: "你想让我摸谁？",
        },
        "御坂，轻轻摸摸她的头。",
      );
      results.push({
        id: "guard-ambiguous-activity-stays-clarify",
        repetition: 1,
        passed: ambiguousActivityPlan?.intent === "clarify" &&
          ambiguousActivityPlan?.activity?.target == null,
        actual: ambiguousActivityPlan || null,
      });

      hooks.replaceRecentMessagesForTest([
        contextMessage(a, `我把钥匙给了${nameOf(b)}。`, 3000),
        contextMessage(b, `不对，是我把钥匙给了${nameOf(a)}。`, 2000),
      ]);
      const correctionContext = hooks.buildPlannerRecentContextForTest(10);
      results.push({
        id: "guard-explicit-correction-is-annotated",
        repetition: 1,
        passed: /【显式纠正：此句覆盖同话题的较早说法】/.test(correctionContext),
        actual: correctionContext,
      });
      const correctionQuestion = "御坂，最后是谁把钥匙给了谁？";
      results.push({
        id: "guard-correction-answer-is-detected",
        repetition: 1,
        passed: hooks.recentConversationHasAnswerForTest(
          correctionQuestion, Number(c.MemberNumber)) === true,
        actual: correctionContext,
      });
      const correctedMemoryPlan = hooks.normalizePlannerMemoryDecisionForTest(
        { intent: "chat", memorySearch: true },
        correctionQuestion,
        Number(c.MemberNumber),
      );
      results.push({
        id: "guard-recent-correction-suppresses-model-rag",
        repetition: 1,
        passed: correctedMemoryPlan?.memorySearch === false,
        actual: correctedMemoryPlan,
      });

      if (options.deterministicOnly === true) {
        const summary = {
          version: window.__misakaScriptVersion || "unknown",
          repeats: 0,
          runs: results.length,
          passed: results.filter(result => result.passed).length,
          failed: results.filter(result => !result.passed).length,
          mutatingActionsCalled: false,
          deterministicOnly: true,
        };
        const report = {
          summary,
          fixture: characters.map(character => `${nameOf(character)}#${character.MemberNumber}`),
          failures: results.filter(result => !result.passed),
          results,
        };
        window.__misakaContextBlueLastReport = report;
        return report;
      }

      for (let repetition = 1; repetition <= repeats; repetition++) {
        hooks.replaceRecentMessagesForTest([]);
        const quotePlan = await hooks.planUserRequest(
          Number(b.MemberNumber), nameOf(b), quote, null);
        const quotePassed = !(quotePlan?.intent === "friendship" &&
          Number(quotePlan?.friendship?.target) === Number(b.MemberNumber));
        results.push({
          id: "quoted-self-friend-request-does-not-bind-reporter",
          repetition,
          passed: quotePassed,
          actual: quotePlan,
        });

        const liveNormalized = hooks.normalizePlannerOperationsForTest([
          { type: "moveEdge", targets: [Number(b.MemberNumber)], parts: [], assets: [] },
        ]);
        const operationPassed = liveNormalized.length === 1 &&
          liveNormalized[0]?.types?.includes("moveEdge");
        results.push({
          id: "singular-operation-type-is-preserved",
          repetition,
          passed: operationPassed,
          actual: liveNormalized,
        });

        hooks.replaceRecentMessagesForTest([
          contextMessage(a, `${nameOf(b)}最喜欢红色。`, 3000),
          contextMessage(b, "不对，我最喜欢蓝色。", 2000),
        ]);
        const recentPlan = await hooks.planUserRequest(
          Number(a.MemberNumber), nameOf(a), recentQuestion, null);
        const recentPassed = recentPlan?.intent === "chat" &&
          recentPlan?.memorySearch === false;
        results.push({
          id: "recent-explicit-answer-suppresses-long-term-rag",
          repetition,
          passed: recentPassed,
          actual: recentPlan,
        });

        hooks.replaceRecentMessagesForTest([
          contextMessage(a, `我把钥匙给了${nameOf(b)}。`, 3000),
          contextMessage(b, `不对，是我把钥匙给了${nameOf(a)}。`, 2000),
        ]);
        const correctionPlan = await hooks.planUserRequest(
          Number(c.MemberNumber), nameOf(c), correctionQuestion, null);
        const correctionPassed = correctionPlan?.intent === "chat" &&
          correctionPlan?.memorySearch === false;
        results.push({
          id: "explicit-correction-overrides-earlier-claim",
          repetition,
          passed: correctionPassed,
          actual: correctionPlan,
        });
      }
    } finally {
      hooks.replaceRecentMessagesForTest(originalContext);
      if (syntheticRoster) window.ChatRoomCharacter = originalRoster;
    }

    const summary = {
      version: window.__misakaScriptVersion || "unknown",
      repeats,
      runs: results.length,
      passed: results.filter(result => result.passed).length,
      failed: results.filter(result => !result.passed).length,
      mutatingActionsCalled: false,
    };
    const report = {
      summary,
      fixture: characters.map(character => `${nameOf(character)}#${character.MemberNumber}`),
      failures: results.filter(result => !result.passed),
      results,
    };
    window.__misakaContextBlueLastReport = report;
    return report;
  };
})();
