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
        !hooks?.normalizeVisibleReplyForTest ||
        !hooks?.parseAssistantReplyForTest ||
        !hooks?.formatStructuredVisibleReplyForTest ||
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

      const bareActionChatReplies = [
        ["歪了歪头", "哈呜？御坂为什么要学会那个啊……"],
        ["眼神警惕起来", "小手术？！咲你对御坂做了什么奇怪的事吗……"],
        ["做了个无奈的表情", "这种事御坂可不敢乱说……你还是自己去问Rin吧！"],
        ["歪着头想了想，露出有点无奈的表情", "Rin啊……挺爱闹腾的一个家伙呢。"],
        ["偏头看了看刚醒过来的伊水，忍不住笑了笑", "伊水嘛，挺可爱的一个家伙呢。"],
        ["拍了拍脑袋", "啊，说得对，我忘记了……"],
        ["脸微微一红，别过头去", "才不是什么充值开关呢……再乱说的话我可要生气了！"],
      ];
      for (const [action, speech] of bareActionChatReplies) {
        const actual = hooks.normalizeVisibleReplyForTest("chat", `${action}\n${speech}`);
        results.push({
          id: `guard-chat-bare-action-is-wrapped-${action}`,
          repetition: 1,
          passed: actual === `*${action}*\n${speech}`,
          actual,
        });
      }

      const speechOnlyChat = "这个嘛……御坂觉得这种问题不太好回答呢。\n你还是自己问Rin吧！";
      const speechOnlyActual = hooks.normalizeVisibleReplyForTest("chat", speechOnlyChat);
      results.push({
        id: "guard-two-line-chat-is-not-misread-as-action",
        repetition: 1,
        passed: speechOnlyActual === speechOnlyChat,
        actual: speechOnlyActual,
      });

      const structuredChat = hooks.parseAssistantReplyForTest(JSON.stringify({
        protocol: "misaka.reply.v1",
        commands: [],
        action: "歪了歪头",
        speech: "哈呜？御坂为什么要学会那个啊……",
      }), "chat");
      results.push({
        id: "guard-structured-action-and-speech-are-rendered-separately",
        repetition: 1,
        passed: structuredChat.structured === true &&
          structuredChat.cleaned === "*歪了歪头*\n哈呜？御坂为什么要学会那个啊……",
        actual: structuredChat,
      });

      const structuredCommand = hooks.parseAssistantReplyForTest(JSON.stringify({
        protocol: "misaka.reply.v1",
        commands: [{
          type: "itemadd",
          memberNumber: Number(b.MemberNumber),
          item: "Hairbrush",
          part: "ItemHandheld",
          color: "",
        }],
        action: "",
        speech: "梳子拿好啦。",
      }), "action");
      results.push({
        id: "guard-structured-command-object-is-normalized-without-visible-tag",
        repetition: 1,
        passed: structuredCommand.structured === true &&
          structuredCommand.commands.length === 1 &&
          structuredCommand.commands[0]?.type === "itemadd" &&
          structuredCommand.commands[0]?.item === "Hairbrush" &&
          structuredCommand.cleaned === "梳子拿好啦。",
        actual: structuredCommand,
      });

      const structuredMove = hooks.parseAssistantReplyForTest(JSON.stringify({
        protocol: "misaka.reply.v1",
        commands: [{
          type: "move",
          memberNumber: Number(b.MemberNumber),
          direction: "left",
        }],
        action: "",
        speech: "",
      }), "action");
      const filteredMove = hooks.filterCommandsByPlan({
        intent: "action",
        operations: [{
          types: ["move"],
          targets: [Number(b.MemberNumber)],
          parts: [],
          assets: [],
        }],
        constraints: {},
      }, structuredMove.commands);
      results.push({
        id: "guard-structured-command-flows-through-existing-plan-filter",
        repetition: 1,
        passed: filteredMove.allowed.length === 1 &&
          filteredMove.rejected.length === 0 &&
          filteredMove.allowed[0]?.type === "move",
        actual: filteredMove,
      });

      const mixedValidityCommands = hooks.parseAssistantReplyForTest(JSON.stringify({
        protocol: "misaka.reply.v1",
        commands: [
          {
            type: "move",
            memberNumber: Number(b.MemberNumber),
            direction: "left",
          },
          {
            type: "itemadd",
            memberNumber: Number(b.MemberNumber),
          },
        ],
        action: "",
        speech: "好了。",
      }), "action");
      results.push({
        id: "guard-invalid-structured-command-rejects-the-whole-envelope",
        repetition: 1,
        passed: mixedValidityCommands.commands.length === 0 &&
          mixedValidityCommands.protocolError === "invalid-command-envelope" &&
          mixedValidityCommands.rejectedCommands.length === 1,
        actual: mixedValidityCommands,
      });

      const fieldAuthoritative = hooks.parseAssistantReplyForTest(JSON.stringify({
        protocol: "misaka.reply.v1",
        commands: [],
        action: "",
        speech: "歪了歪头只是这句话里被引用的内容，不是御坂当前做出的动作。",
      }), "chat");
      results.push({
        id: "guard-structured-speech-is-not-reclassified-by-action-heuristic",
        repetition: 1,
        passed: fieldAuthoritative.cleaned ===
          "歪了歪头只是这句话里被引用的内容，不是御坂当前做出的动作。",
        actual: fieldAuthoritative,
      });

      const multilineSpeech = hooks.formatStructuredVisibleReplyForTest(
        "轻轻站直",
        "第一句话。\n第二句话仍然保留。\n第三句话也不会因行数被直接丢弃。",
      );
      results.push({
        id: "guard-structured-speech-merges-lines-without-dropping-meaning",
        repetition: 1,
        passed: multilineSpeech ===
          "*轻轻站直*\n第一句话。 第二句话仍然保留。 第三句话也不会因行数被直接丢弃。",
        actual: multilineSpeech,
      });

      const unicodeLimited = hooks.formatStructuredVisibleReplyForTest("", "🎐".repeat(330));
      const unicodeLength = typeof Intl?.Segmenter === "function"
        ? [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(unicodeLimited)].length
        : Array.from(unicodeLimited).length;
      results.push({
        id: "guard-structured-truncation-is-unicode-safe",
        repetition: 1,
        passed: unicodeLength === 320 &&
          unicodeLimited.endsWith("…") &&
          !unicodeLimited.includes("\uFFFD"),
        actual: { unicodeLength, suffix: Array.from(unicodeLimited).slice(-4).join("") },
      });

      const malformedEnvelope = hooks.parseAssistantReplyForTest(
        '{"protocol":"misaka.reply.v1","commands":[],"action":"歪头","speech":',
        "chat",
      );
      results.push({
        id: "guard-malformed-structured-json-is-not-leaked-to-room",
        repetition: 1,
        passed: malformedEnvelope.structured === true &&
          malformedEnvelope.protocolError === "invalid-json" &&
          !malformedEnvelope.cleaned.includes("{"),
        actual: malformedEnvelope,
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

      const selfHairCarePlan = hooks.normalizePlannerActivityDecisionForTest?.(
        {
          intent: "roleplay",
          memorySearch: false,
          activity: { target: null, request: "帮我编辫子" },
          question: "",
        },
        "御坂，帮我编辫子",
        Number(a.MemberNumber),
      );
      results.push({
        id: "guard-explicit-self-hair-care-binds-the-sender",
        repetition: 1,
        passed: selfHairCarePlan?.intent === "activity" &&
          Number(selfHairCarePlan?.activity?.target) === Number(a.MemberNumber),
        actual: selfHairCarePlan || null,
      });

      const mismatchedNamedTargetPlan = hooks.normalizePlannerActivityDecisionForTest?.(
        {
          intent: "activity",
          memorySearch: false,
          activity: { target: Number(c.MemberNumber), request: "亲一下她的嘴" },
          question: "",
        },
        `御坂，亲一下${nameOf(b)}的嘴。`,
        Number(a.MemberNumber),
      );
      results.push({
        id: "guard-explicit-named-activity-overrides-the-wrong-model-target",
        repetition: 1,
        passed: mismatchedNamedTargetPlan?.intent === "activity" &&
          Number(mismatchedNamedTargetPlan?.activity?.target) === Number(b.MemberNumber),
        actual: mismatchedNamedTargetPlan || null,
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
