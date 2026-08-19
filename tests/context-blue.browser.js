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
        !hooks?.formatMessageForContextForTest ||
        !hooks?.isLegacySelfFormattingMemoryForTest ||
        !hooks?.parseAssistantReplyForTest ||
        !hooks?.formatStructuredVisibleReplyForTest ||
        !hooks?.normalizePlannerMemoryDecisionForTest ||
        !hooks?.normalizeAssistantIdentityForTest ||
        !hooks?.enrichPlannerAssetsFromExplicitMentionsForTest ||
        !hooks?.normalizePlannerExplicitActionTargetsForTest ||
        !hooks?.normalizePlannerExplicitItemAddDecisionForTest ||
        !hooks?.normalizePlannerColloquialItemAliasesForTest ||
        !hooks?.normalizePlannerBroadDestructiveDecisionForTest ||
        !hooks?.recoverExplicitCurrentItemOperationForTest ||
        !hooks?.dryRunEmptyContentRecoveryForTest ||
        !hooks?.dryRunCallBurstForTest) {
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
    const embeddingProviders = hooks.inspectEmbeddingConfigForTest?.() || [];
    results.push({
      id: "guard-embedding-uses-only-openai-key",
      repetition: 1,
      passed: embeddingProviders.length === 1 &&
        embeddingProviders[0]?.name === "OpenAI" &&
        embeddingProviders[0]?.model === "text-embedding-3-large" &&
        embeddingProviders[0]?.dimensions === 3072 &&
        JSON.stringify(embeddingProviders[0]?.keyNames) === JSON.stringify(["misaka_openai_key"]),
      actual: embeddingProviders,
    });
    const currentRoomBehavior = hooks.normalizePlannerMemoryDecisionForTest({
      intent: "chat",
      memorySearch: true,
      memoryEntities: [],
    }, "御坂不知道为什么老是在自动更新房间", Number(a.MemberNumber));
    results.push({
      id: "guard-current-room-behavior-does-not-enter-long-term-memory",
      repetition: 1,
      passed: currentRoomBehavior.memorySearch === false,
      actual: currentRoomBehavior,
    });
    const datedRoomBehavior = hooks.normalizePlannerMemoryDecisionForTest({
      intent: "chat",
      memorySearch: false,
      memoryEntities: [],
    }, "御坂，上次为什么老是在自动更新房间？", Number(a.MemberNumber));
    results.push({
      id: "guard-explicitly-dated-room-behavior-can-still-query-memory",
      repetition: 1,
      passed: datedRoomBehavior.memorySearch === true,
      actual: datedRoomBehavior,
    });
    results.push({
      id: "guard-unmentioned-player-name-cannot-become-assistant-self-reference",
      repetition: 1,
      passed: hooks.normalizeAssistantIdentityForTest(
        "*轻轻歪头*\n咲觉得可能是房间信息量太大。",
        "御坂不知道为什么老是在自动更新房间",
      ) === "*轻轻歪头*\n我觉得可能是房间信息量太大。",
      actual: hooks.normalizeAssistantIdentityForTest(
        "*轻轻歪头*\n咲觉得可能是房间信息量太大。",
        "御坂不知道为什么老是在自动更新房间",
      ),
    });
    results.push({
      id: "guard-explicit-third-person-opinion-keeps-their-name",
      repetition: 1,
      passed: hooks.normalizeAssistantIdentityForTest(
        "咲觉得这个房间挺好的。",
        "御坂，咲觉得这个房间怎么样？",
      ) === "咲觉得这个房间挺好的。",
      actual: hooks.normalizeAssistantIdentityForTest(
        "咲觉得这个房间挺好的。",
        "御坂，咲觉得这个房间怎么样？",
      ),
    });

    try {
      const originalXHR = window.XMLHttpRequest;
      const originalGMRequest = window.__GM_xmlhttpRequest;
      const attemptThinkingModes = [];
      const structuredRequestShapes = [];
      class EmptyThinkingResponseXHR {
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader() {}
        send(body) {
          const request = JSON.parse(String(body || "{}"));
          const thinkingMode = request?.reasoning?.effort || "missing";
          attemptThinkingModes.push(thinkingMode);
          structuredRequestShapes.push({
            url: this.url,
            format: request?.text?.format?.type || "",
            strict: request?.text?.format?.strict === true,
            protocol: request?.text?.format?.schema?.properties?.protocol?.enum?.[0] || "",
          });
          const content = thinkingMode === "none"
            ? JSON.stringify({
                protocol: "misaka.reply.v1",
                commands: [],
                action: "",
                speech: "恢复成功。",
              })
            : "";
          this.status = 200;
          this.responseText = JSON.stringify({
            status: "completed",
            output: [{
              type: "message",
              content: [{ type: "output_text", text: content }],
            }],
            usage: { output_tokens: 20, output_tokens_details: { reasoning_tokens: 10 } },
          });
          queueMicrotask(() => this.onload?.());
        }
        abort() { this.onabort?.(); }
      }
      let emptyContentRecovery = null;
      try {
        window.__GM_xmlhttpRequest = undefined;
        window.XMLHttpRequest = EmptyThinkingResponseXHR;
        emptyContentRecovery = await hooks.dryRunEmptyContentRecoveryForTest();
      } finally {
        window.XMLHttpRequest = originalXHR;
        window.__GM_xmlhttpRequest = originalGMRequest;
      }
      results.push({
        id: "guard-empty-thinking-content-does-not-trigger-a-second-model-call",
        repetition: 1,
        passed: emptyContentRecovery === null &&
          JSON.stringify(attemptThinkingModes) === JSON.stringify(["high"]) &&
          structuredRequestShapes[0]?.url === "https://api.deepseek.com/responses" &&
          structuredRequestShapes[0]?.format === "json_schema" &&
          structuredRequestShapes[0]?.strict === true &&
          structuredRequestShapes[0]?.protocol === "misaka.reply.v1",
        actual: { emptyContentRecovery, attemptThinkingModes, structuredRequestShapes },
      });

      class ImmediateValidXHR {
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader() {}
        send(body) {
          const request = JSON.parse(String(body || "{}"));
          structuredRequestShapes.push({
            url: this.url,
            format: request?.text?.format?.type || "",
            strict: request?.text?.format?.strict === true,
            reasoning: request?.reasoning?.effort || "",
          });
          this.status = 200;
          this.responseText = JSON.stringify({
            status: "completed",
            output: [{
              type: "message",
              content: [{
                type: "output_text",
                text: JSON.stringify({
                  protocol: "misaka.reply.v1",
                  commands: [],
                  action: "",
                  speech: "正常回复。",
                }),
              }],
            }],
            usage: { output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } },
          });
          queueMicrotask(() => this.onload?.());
        }
        abort() { this.onabort?.(); }
      }
      let throttleBurst = [];
      try {
        window.__GM_xmlhttpRequest = undefined;
        window.XMLHttpRequest = ImmediateValidXHR;
        throttleBurst = await hooks.dryRunCallBurstForTest(31);
      } finally {
        window.XMLHttpRequest = originalXHR;
        window.__GM_xmlhttpRequest = originalGMRequest;
      }
      results.push({
        id: "guard-rapid-model-calls-are-not-locally-dropped",
        repetition: 1,
        passed: throttleBurst.length === 31 && throttleBurst.every(Boolean),
        actual: {
          runs: throttleBurst.length,
          nonEmpty: throttleBurst.filter(Boolean).length,
          emptyIndexes: throttleBurst.map((value, index) => value ? -1 : index + 1).filter(index => index > 0),
        },
      });

      const quote = `${nameOf(c)}刚才说“御坂，加我好友”，你听到了吗？`;
      const unquoted = hooks.stripQuotedSegmentsForTest(quote);
      results.push({
        id: "guard-quoted-content-is-not-a-self-request",
        repetition: 1,
        passed: !/(?:加|添加).{0,8}(?:好友|朋友)/.test(unquoted),
        actual: unquoted,
      });

      const quotedOperationPlan = hooks.normalizePlannerQuotedReportDecisionForTest({
        intent: "action",
        memorySearch: false,
        needsCatalog: true,
        operations: [{
          types: ["itemadd"],
          targets: [Number(c.MemberNumber)],
          parts: ["Mouth"],
          assets: ["BallGag"],
        }],
      }, `${nameOf(c)}说“御坂，给我戴口球”，你听到了吗？`);
      results.push({
        id: "guard-quoted-reported-command-is-not-executed",
        repetition: 1,
        passed: quotedOperationPlan.intent === "chat" &&
          quotedOperationPlan.operations.length === 0 &&
          quotedOperationPlan.needsCatalog === false,
        actual: quotedOperationPlan,
      });

      const ambiguousItemPlan = hooks.normalizePlannerAmbiguousSingleItemDecisionForTest({
        intent: "action",
        memorySearch: false,
        needsCatalog: true,
        operations: [{
          types: ["itemset"],
          targets: [Number(b.MemberNumber)],
          parts: [],
          assets: [],
        }],
      }, `御坂，${nameOf(b)}那个玩具开到最高档`);
      results.push({
        id: "guard-ambiguous-singular-item-does-not-expand-to-all",
        repetition: 1,
        passed: ambiguousItemPlan.intent === "clarify" &&
          ambiguousItemPlan.operations.length === 0 &&
          /哪一个/.test(ambiguousItemPlan.question),
        actual: ambiguousItemPlan,
      });

      const explicitItemPlan = hooks.normalizePlannerAmbiguousSingleItemDecisionForTest({
        intent: "action",
        operations: [{
          types: ["itemset"],
          targets: [Number(b.MemberNumber)],
          parts: [],
          assets: ["FuturisticVibrator"],
        }],
      }, `御坂，${nameOf(b)}那个玩具开到最高档`);
      results.push({
        id: "guard-context-resolved-singular-item-remains-actionable",
        repetition: 1,
        passed: explicitItemPlan.intent === "action" &&
          explicitItemPlan.operations[0]?.assets?.[0] === "FuturisticVibrator",
        actual: explicitItemPlan,
      });

      const recoveredPetBedPlan = hooks.normalizePlannerExplicitItemAddDecisionForTest({
        intent: "clarify",
        failed: true,
        memorySearch: false,
        needsCatalog: false,
        operations: [],
        question: "你想让我做什么？",
      }, `御坂，给${nameOf(b)}装备PetBed`);
      results.push({
        id: "guard-explicit-petbed-recovers-from-planner-clarify",
        repetition: 1,
        passed: recoveredPetBedPlan.intent === "action" &&
          recoveredPetBedPlan.failed === false &&
          recoveredPetBedPlan.operations[0]?.assets?.[0] === "PetBed" &&
          recoveredPetBedPlan.operations[0]?.targets?.[0] === Number(b.MemberNumber),
        actual: recoveredPetBedPlan,
      });

      const existingPetBedMutation = hooks.normalizePlannerExplicitItemAddDecisionForTest({
        intent: "action",
        operations: [{
          types: ["itemcolor"],
          targets: [Number(b.MemberNumber)],
          parts: ["Devices"],
          assets: ["PetBed"],
        }],
      }, `御坂，把${nameOf(b)}的PetBed改成红色`);
      results.push({
        id: "guard-explicit-add-recovery-does-not-overwrite-item-mutation",
        repetition: 1,
        passed: existingPetBedMutation.operations[0]?.types?.[0] === "itemcolor" &&
          existingPetBedMutation.operations.length === 1,
        actual: existingPetBedMutation,
      });

      const clarifyRemoval = hooks.normalizePlannerExplicitItemAddDecisionForTest({
        intent: "clarify",
        operations: [],
        question: "你要做什么？",
      }, `御坂，把${nameOf(b)}的BallGag取下来`);
      results.push({
        id: "guard-explicit-add-recovery-never-inverts-removal-into-add",
        repetition: 1,
        passed: clarifyRemoval.intent === "clarify" &&
          clarifyRemoval.operations.length === 0,
        actual: clarifyRemoval,
      });

      const ambiguousPetBedPlan = hooks.normalizePlannerExplicitItemAddDecisionForTest({
        intent: "clarify",
        operations: [],
        question: "给谁？",
      }, "御坂，给她装个窝窝");
      results.push({
        id: "guard-ambiguous-petbed-target-stays-clarify",
        repetition: 1,
        passed: ambiguousPetBedPlan.intent === "clarify" &&
          ambiguousPetBedPlan.operations.length === 0,
        actual: ambiguousPetBedPlan,
      });

      const colloquialPetBedPlan = hooks.normalizePlannerColloquialItemAliasesForTest({
        intent: "action",
        operations: [{
          types: ["itemadd"],
          targets: [Number(b.MemberNumber)],
          parts: ["Devices"],
          assets: ["LowCage"],
        }],
      }, `御坂，给${nameOf(b)}发个窝窝`);
      results.push({
        id: "guard-colloquial-wowow-means-petbed-not-lowcage",
        repetition: 1,
        passed: colloquialPetBedPlan.operations[0]?.assets?.[0] === "PetBed" &&
          colloquialPetBedPlan.operations[0]?.parts?.[0] === "Devices",
        actual: colloquialPetBedPlan,
      });

      const broadDeletePlan = hooks.normalizePlannerBroadDestructiveDecisionForTest({
        intent: "action",
        memorySearch: false,
        needsCatalog: true,
        operations: [{
          types: ["itemdelall"],
          targets: [Number(a.MemberNumber), Number(b.MemberNumber), Number(c.MemberNumber)],
          parts: [],
          assets: [],
        }],
      }, "御坂，把所有人的东西全脱了");
      results.push({
        id: "guard-broad-itemdelall-requires-confirmation",
        repetition: 1,
        passed: broadDeletePlan.intent === "clarify" &&
          broadDeletePlan.operations.length === 0 &&
          /确定/.test(broadDeletePlan.question),
        actual: broadDeletePlan,
      });

      const confirmedBroadDelete = hooks.normalizePlannerBroadDestructiveDecisionForTest({
        intent: "action",
        usedPendingClarification: true,
        operations: [{
          types: ["itemdelall"],
          targets: [Number(a.MemberNumber), Number(b.MemberNumber)],
          parts: [],
          assets: [],
        }],
      }, "确认执行");
      results.push({
        id: "guard-confirmed-broad-itemdelall-can-proceed",
        repetition: 1,
        passed: confirmedBroadDelete.intent === "action" &&
          confirmedBroadDelete.operations.length === 1,
        actual: confirmedBroadDelete,
      });

      const todaySmallTalkPlan = hooks.normalizePlannerMemoryDecisionForTest({
        intent: "chat",
        memorySearch: true,
        memoryEntities: ["御坂"],
      }, "御坂，今天发生了什么有趣的事", Number(a.MemberNumber));
      results.push({
        id: "guard-today-smalltalk-does-not-enter-long-term-memory",
        repetition: 1,
        passed: todaySmallTalkPlan.intent === "chat" &&
          todaySmallTalkPlan.memorySearch === false,
        actual: todaySmallTalkPlan,
      });

      const winkPlan = hooks.normalizePlannerSimpleRoleplayDecisionForTest({
        intent: "action",
        operations: [{
          types: ["emote"],
          targets: [Number(Player?.MemberNumber)],
          parts: [],
          assets: [],
        }],
      }, "御坂，朝我眨眨眼");
      results.push({
        id: "guard-simple-wink-is-visible-roleplay",
        repetition: 1,
        passed: winkPlan.intent === "roleplay" &&
          winkPlan.operations.length === 0,
        actual: winkPlan,
      });

      const malformedReply = hooks.parseAssistantReply(
        '{"protocol":"misaka.reply.v1","commands":[],"action":"","speech":"Rin说最喜欢蓝色哦～"}}',
        "chat",
      );
      results.push({
        id: "guard-trailing-json-brace-keeps-valid-reply",
        repetition: 1,
        passed: malformedReply.protocolError === "" &&
          /蓝色/.test(malformedReply.cleaned),
        actual: malformedReply,
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

      const explicitHairbrushPlan = {
        intent: "action",
        operations: [{
          types: ["itemadd", "itemset"],
          targets: [Number(b.MemberNumber)],
          parts: [],
          assets: [],
        }],
      };
      hooks.enrichPlannerAssetsFromExplicitMentionsForTest(
        explicitHairbrushPlan,
        `递给${nameOf(b)}一把梳子`,
      );
      results.push({
        id: "guard-explicit-catalog-description-pins-unique-asset",
        repetition: 1,
        passed: explicitHairbrushPlan.operations[0]?.assets?.length === 1 &&
          explicitHairbrushPlan.operations[0].assets[0] === "Hairbrush",
        actual: explicitHairbrushPlan,
      });

      const exactRin = (window.ChatRoomCharacter || []).find(character =>
        String(character?.Nickname || character?.Name || "").trim().toLowerCase() === "rin");
      const aliasedRin = (window.ChatRoomCharacter || []).find(character =>
        Number(character?.MemberNumber) !== Number(exactRin?.MemberNumber) &&
        String(character?.Name || "").trim().toLowerCase() === "rin");
      if (exactRin && aliasedRin) {
        const explicitDisplayTargetPlan = {
          intent: "action",
          operations: [{
            types: ["itemadd"],
            targets: [Number(aliasedRin.MemberNumber)],
            parts: [],
            assets: ["Hairbrush"],
          }],
        };
        hooks.normalizePlannerExplicitActionTargetsForTest(
          explicitDisplayTargetPlan,
          "递给Rin一把梳子",
        );
        results.push({
          id: "guard-exact-display-name-beats-another-players-account-alias",
          repetition: 1,
          passed: explicitDisplayTargetPlan.operations[0]?.targets?.length === 1 &&
            explicitDisplayTargetPlan.operations[0].targets[0] === Number(exactRin.MemberNumber),
          actual: {
            exactRin: Number(exactRin.MemberNumber),
            aliasedRin: Number(aliasedRin.MemberNumber),
            plan: explicitDisplayTargetPlan,
          },
        });
      }

      const wornForRecovery = (b.Appearance || []).find(item =>
        item?.Asset?.Group?.Name?.startsWith("Item"));
      if (wornForRecovery) {
        const droppedCurrentItemPlan = {
          intent: "clarify",
          needsCatalog: true,
          goal: `把${nameOf(b)}的${wornForRecovery.Asset.Description}改成红色`,
          operations: [],
          question: "你想让我对谁做什么？",
        };
        hooks.recoverExplicitCurrentItemOperationForTest(
          droppedCurrentItemPlan,
          `把${nameOf(b)}的${wornForRecovery.Asset.Description}改成红色`,
        );
        results.push({
          id: "guard-explicit-current-item-modification-recovers-dropped-operation",
          repetition: 1,
          passed: droppedCurrentItemPlan.intent === "action" &&
            droppedCurrentItemPlan.operations.length === 1 &&
            droppedCurrentItemPlan.operations[0]?.types?.includes("itemcolor") &&
            droppedCurrentItemPlan.operations[0]?.targets?.[0] === Number(b.MemberNumber) &&
            droppedCurrentItemPlan.operations[0]?.assets?.[0] === wornForRecovery.Asset.Name &&
            droppedCurrentItemPlan.question === "",
          actual: droppedCurrentItemPlan,
        });

        const misclassifiedCurrentItemPlan = {
          intent: "action",
          needsCatalog: false,
          goal: `把${nameOf(b)}的${wornForRecovery.Asset.Description}改成红色`,
          operations: [{
            types: ["emote"],
            targets: [Number(b.MemberNumber)],
            parts: [],
            assets: [],
          }],
          question: "",
        };
        hooks.recoverExplicitCurrentItemOperationForTest(
          misclassifiedCurrentItemPlan,
          `把${nameOf(b)}的${wornForRecovery.Asset.Description}改成红色`,
        );
        results.push({
          id: "guard-explicit-current-item-modification-replaces-wrong-operation-family",
          repetition: 1,
          passed: misclassifiedCurrentItemPlan.operations.length === 1 &&
            misclassifiedCurrentItemPlan.operations[0]?.types?.includes("itemcolor") &&
            !misclassifiedCurrentItemPlan.operations[0]?.types?.includes("emote") &&
            misclassifiedCurrentItemPlan.needsCatalog === true,
          actual: misclassifiedCurrentItemPlan,
        });
      }

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

      const typedActionContext = hooks.formatMessageForContextForTest({
        content: "歪了歪头",
        isSelf: true,
        messageType: "Emote",
      });
      const typedSpeechContext = hooks.formatMessageForContextForTest({
        content: "怎么了？",
        isSelf: true,
        messageType: "Chat",
      });
      const typedOtherActivityContext = hooks.formatMessageForContextForTest({
        content: "摸了摸御坂的头",
        isSelf: false,
        messageType: "Activity",
      });
      results.push({
        id: "guard-all-recent-history-preserves-raw-bc-types",
        repetition: 1,
        passed: typedActionContext === "【Emote】歪了歪头" &&
          typedSpeechContext === "【Chat】怎么了？" &&
          typedOtherActivityContext === "【Activity】摸了摸御坂的头",
        actual: { typedActionContext, typedSpeechContext, typedOtherActivityContext },
      });

      const oldSelfPipeMemory = hooks.isLegacySelfFormattingMemoryForTest({
        text: "御搬: 歪了歪头|怎么了？",
        isSelf: true,
        messageType: "Chat",
      });
      const oldSelfEmoteMemory = hooks.isLegacySelfFormattingMemoryForTest({
        text: "御搬: 歪了歪头",
        isSelf: true,
        messageType: "Emote",
      });
      const otherPersonPipeMemory = hooks.isLegacySelfFormattingMemoryForTest({
        text: "Rin: 看这里|ω･)",
        isSelf: false,
        messageType: "Chat",
      });
      results.push({
        id: "guard-legacy-self-formatting-memories-are-quarantined-without-deletion",
        repetition: 1,
        passed: oldSelfPipeMemory === true && oldSelfEmoteMemory === true &&
          otherPersonPipeMemory === false,
        actual: { oldSelfPipeMemory, oldSelfEmoteMemory, otherPersonPipeMemory },
      });

      const legacyTextReply = hooks.parseAssistantReplyForTest(
        "歪了歪头|怎么了？",
        "chat",
      );
      results.push({
        id: "guard-legacy-pipe-reply-is-rejected-instead-of-repaired",
        repetition: 1,
        passed: legacyTextReply.structured === false &&
          legacyTextReply.protocolError === "structured-reply-required" &&
          legacyTextReply.cleaned === "",
        actual: legacyTextReply,
      });

      const structuredLegacyPipe = hooks.parseAssistantReplyForTest(JSON.stringify({
        protocol: "misaka.reply.v1",
        commands: [],
        action: "",
        speech: "歪了歪头|怎么了？",
      }), "chat");
      results.push({
        id: "guard-schema-fields-reject-legacy-pipe-separator",
        repetition: 1,
        passed: structuredLegacyPipe.structured === true &&
          structuredLegacyPipe.protocolError === "invalid-visible-field-format",
        actual: structuredLegacyPipe,
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

      const resolveItemAddTarget = (item, part) =>
        hooks.resolveItemAddTargetForTest?.(
          item,
          part,
          Number(b.MemberNumber),
        ) || null;
      const nativeDeviceGroup = resolveItemAddTarget("PetBed", "ItemDevices");
      results.push({
        id: "guard-itemadd-accepts-validated-native-device-group",
        repetition: 1,
        passed: nativeDeviceGroup?.ok === true &&
          nativeDeviceGroup?.group === "ItemDevices" &&
          nativeDeviceGroup?.asset === "PetBed",
        actual: nativeDeviceGroup,
      });

      const semanticDevicePart = resolveItemAddTarget("PetBed", "Devices");
      results.push({
        id: "guard-itemadd-accepts-semantic-device-part",
        repetition: 1,
        passed: semanticDevicePart?.ok === true &&
          semanticDevicePart?.group === "ItemDevices" &&
          semanticDevicePart?.asset === "PetBed",
        actual: semanticDevicePart,
      });

      const omittedDevicePart = resolveItemAddTarget("PetBed", "");
      results.push({
        id: "guard-itemadd-uses-asset-default-group-when-part-is-empty",
        repetition: 1,
        passed: omittedDevicePart?.ok === true &&
          omittedDevicePart?.group === "ItemDevices" &&
          omittedDevicePart?.asset === "PetBed",
        actual: omittedDevicePart,
      });

      const incompatibleDeviceGroup = resolveItemAddTarget("PetBed", "ItemArms");
      results.push({
        id: "guard-itemadd-rejects-native-group-that-does-not-own-the-asset",
        repetition: 1,
        passed: incompatibleDeviceGroup?.ok === false &&
          incompatibleDeviceGroup?.reason === "incompatible-part",
        actual: incompatibleDeviceGroup,
      });

      const nativeHandheldGroup = resolveItemAddTarget("Hairbrush", "ItemHandheld");
      results.push({
        id: "guard-itemadd-accepts-validated-native-handheld-group",
        repetition: 1,
        passed: nativeHandheldGroup?.ok === true &&
          nativeHandheldGroup?.group === "ItemHandheld" &&
          nativeHandheldGroup?.asset === "Hairbrush",
        actual: nativeHandheldGroup,
      });

      const semanticArmPart = resolveItemAddTarget("HempRope", "Arms");
      results.push({
        id: "guard-itemadd-keeps-semantic-limb-placement",
        repetition: 1,
        passed: semanticArmPart?.ok === true &&
          semanticArmPart?.group === "ItemArms" &&
          semanticArmPart?.asset === "HempRope",
        actual: semanticArmPart,
      });

      const unknownPart = resolveItemAddTarget("PetBed", "Furniture");
      results.push({
        id: "guard-itemadd-rejects-unknown-freeform-part",
        repetition: 1,
        passed: unknownPart?.ok === false &&
          unknownPart?.reason === "unknown-part",
        actual: unknownPart,
      });

      const nativeDeviceCommand = {
        type: "itemadd",
        memberNumber: Number(b.MemberNumber),
        item: "PetBed",
        part: "ItemDevices",
        color: "",
      };
      const preserveDevicePlan = {
        intent: "action",
        operations: [{
          types: ["itemadd"],
          targets: [Number(b.MemberNumber)],
          parts: ["Devices"],
          assets: ["PetBed"],
        }],
        constraints: {
          preserveParts: ["Devices"],
        },
      };
      const preservedNativeDevice = hooks.filterCommandsByPlan(
        preserveDevicePlan,
        [nativeDeviceCommand],
      );
      results.push({
        id: "guard-semantic-preserve-part-blocks-equivalent-native-group",
        repetition: 1,
        passed: preservedNativeDevice.allowed.length === 0 &&
          preservedNativeDevice.rejected.length === 1 &&
          preservedNativeDevice.rejected[0]?.reason === "part-must-be-preserved",
        actual: preservedNativeDevice,
      });

      const preserveArmsPlan = {
        ...preserveDevicePlan,
        constraints: {
          preserveParts: ["Arms"],
        },
      };
      const unrelatedNativeDevice = hooks.filterCommandsByPlan(
        preserveArmsPlan,
        [nativeDeviceCommand],
      );
      results.push({
        id: "guard-semantic-preserve-part-does-not-block-unrelated-native-group",
        repetition: 1,
        passed: unrelatedNativeDevice.allowed.length === 1 &&
          unrelatedNativeDevice.rejected.length === 0,
        actual: unrelatedNativeDevice,
      });

      const unscopedHairbrushPlan = {
        intent: "action",
        operations: [{
          types: ["itemadd", "itemset"],
          targets: [Number(b.MemberNumber)],
          parts: [],
          assets: ["Hairbrush"],
        }],
        constraints: {
          preserveParts: [],
        },
      };
      const misplacedHairbrush = {
        type: "itemadd",
        memberNumber: Number(b.MemberNumber),
        item: "Hairbrush",
        part: "Hands",
        color: "",
      };
      const canonicalHairbrush = hooks.filterCommandsByPlan(
        unscopedHairbrushPlan,
        [misplacedHairbrush],
      );
      results.push({
        id: "guard-unscoped-exact-asset-canonicalizes-incompatible-semantic-part",
        repetition: 1,
        passed: canonicalHairbrush.allowed.length === 1 &&
          canonicalHairbrush.allowed[0]?.part === "ItemHandheld" &&
          canonicalHairbrush.rejected.length === 0,
        actual: canonicalHairbrush,
      });

      const semanticGroupMatrix = {
        Arms: ["ItemArms"],
        Hands: ["ItemHands"],
        Legs: ["ItemLegs"],
        Feet: ["ItemFeet"],
        Mouth: ["ItemMouth", "ItemMouth2", "ItemMouth3"],
        Head: ["ItemHead", "ItemHood"],
        Neck: ["ItemNeck", "ItemNeckRestraints"],
        Torso: ["ItemTorso", "ItemTorso2"],
        Pelvis: ["ItemPelvis"],
        Breast: ["ItemBreast", "ItemNipples", "ItemNipplesPiercings"],
        Eyes: ["ItemHead"],
        Ears: ["ItemEars"],
        Vulva: ["ItemVulva", "ItemVulvaPiercings", "ItemButt", "ItemClit"],
        Devices: ["ItemDevices"],
      };
      const targetFamily = b.AssetFamily || window.Player?.AssetFamily;
      for (const [semanticPart, nativeGroups] of Object.entries(semanticGroupMatrix)) {
        for (const nativeGroup of nativeGroups) {
          const asset = (window.Asset || []).find(candidate =>
            candidate?.Group?.Name === nativeGroup &&
            (!targetFamily || window.AssetGet?.(targetFamily, nativeGroup, candidate.Name)));
          if (!asset) continue;
          const native = resolveItemAddTarget(asset.Name, nativeGroup);
          const semantic = resolveItemAddTarget(asset.Name, semanticPart);
          const preservePlan = {
            intent: "action",
            operations: [{
              types: ["itemadd"],
              targets: [Number(b.MemberNumber)],
              parts: [semanticPart],
              assets: [asset.Name],
            }],
            constraints: {
              preserveParts: [semanticPart],
            },
          };
          const nativeCommand = {
            type: "itemadd",
            memberNumber: Number(b.MemberNumber),
            item: asset.Name,
            part: nativeGroup,
            color: "",
          };
          const preserved = hooks.filterCommandsByPlan(preservePlan, [nativeCommand]);
          results.push({
            id: `matrix-native-and-semantic-group-equivalence:${semanticPart}:${nativeGroup}`,
            repetition: 1,
            passed: native?.ok === true &&
              native?.group === nativeGroup &&
              semantic?.ok === true &&
              nativeGroups.includes(semantic.group) &&
              preserved.allowed.length === 0 &&
              preserved.rejected[0]?.reason === "part-must-be-preserved",
            actual: { asset: asset.Name, native, semantic, preserved },
          });
        }
      }

      const wornItem = (b.Appearance || []).find(item =>
        item?.Asset?.Group?.Name?.startsWith("Item"));
      if (wornItem) {
        const wornGroup = wornItem.Asset.Group.Name;
        const wornSemanticPart = Object.entries(semanticGroupMatrix)
          .find(([, groups]) => groups.includes(wornGroup))?.[0] || "";
        if (wornSemanticPart) {
          for (const type of ["itemdel", "itemset"]) {
            const command = {
              type,
              memberNumber: Number(b.MemberNumber),
              item: wornItem.Asset.Name,
              part: wornGroup,
              ...(type === "itemset" ? { property: "样式", value: "测试值" } : {}),
            };
            const plan = {
              intent: "action",
              operations: [{
                types: [type],
                targets: [Number(b.MemberNumber)],
                parts: [wornSemanticPart],
                assets: [wornItem.Asset.Name],
              }],
              constraints: {
                preserveParts: [wornSemanticPart],
              },
            };
            const filtered = hooks.filterCommandsByPlan(plan, [command]);
            results.push({
              id: `guard-${type}-native-group-respects-semantic-preserve-part`,
              repetition: 1,
              passed: filtered.allowed.length === 0 &&
                filtered.rejected[0]?.reason === "part-must-be-preserved",
              actual: { wornGroup, wornSemanticPart, filtered },
            });
          }
        }
      }

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

      const structuredMoveTo = hooks.parseAssistantReplyForTest(JSON.stringify({
        protocol: "misaka.reply.v1",
        commands: [{
          type: "moveTo",
          memberNumber: Number(Player.MemberNumber),
          targetNumber: Number(b.MemberNumber),
          side: "left",
        }],
        action: "",
        speech: "",
      }), "action");
      const relativeMovePlan = {
        intent: "action",
        operations: [{
          types: ["moveTo"],
          targets: [Number(Player.MemberNumber)],
          referenceTargets: [Number(b.MemberNumber)],
          side: "left",
          parts: [],
          assets: [],
        }],
        constraints: {},
      };
      const filteredMoveTo = hooks.filterCommandsByPlan(
        relativeMovePlan,
        structuredMoveTo.commands,
      );
      results.push({
        id: "guard-move-to-distinguishes-moved-and-reference-targets",
        repetition: 1,
        passed: filteredMoveTo.allowed.length === 1 &&
          filteredMoveTo.rejected.length === 0 &&
          filteredMoveTo.allowed[0]?.memberNumber === Number(Player.MemberNumber) &&
          filteredMoveTo.allowed[0]?.targetNumber === Number(b.MemberNumber),
        actual: filteredMoveTo,
      });
      const wrongReferenceMoveTo = hooks.filterCommandsByPlan({
        ...relativeMovePlan,
        operations: [{
          ...relativeMovePlan.operations[0],
          referenceTargets: [Number(a.MemberNumber)],
        }],
      }, structuredMoveTo.commands);
      results.push({
        id: "guard-move-to-rejects-unplanned-reference-target",
        repetition: 1,
        passed: wrongReferenceMoveTo.allowed.length === 0 &&
          wrongReferenceMoveTo.rejected[0]?.reason === "outside-plan-boundary",
        actual: wrongReferenceMoveTo,
      });
      const wrongSideMoveTo = hooks.filterCommandsByPlan({
        ...relativeMovePlan,
        operations: [{
          ...relativeMovePlan.operations[0],
          side: "right",
        }],
      }, structuredMoveTo.commands);
      results.push({
        id: "guard-move-to-rejects-unplanned-side",
        repetition: 1,
        passed: wrongSideMoveTo.allowed.length === 0 &&
          wrongSideMoveTo.rejected[0]?.reason === "outside-plan-boundary",
        actual: wrongSideMoveTo,
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

      const missingClosingBrace = hooks.parseAssistantReplyForTest(
        '{"protocol":"misaka.reply.v1","commands":[],"action":"","speech":"蓝色。"',
        "chat",
      );
      results.push({
        id: "guard-json-missing-only-closing-brace-is-safely-completed",
        repetition: 1,
        passed: missingClosingBrace.structured === true &&
          missingClosingBrace.protocolError === "" &&
          missingClosingBrace.cleaned === "蓝色。",
        actual: missingClosingBrace,
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

        hooks.replaceRecentMessagesForTest([]);
        const roomBehaviorReply = await hooks.dryRunConversationForTest(
          Number(a.MemberNumber), nameOf(a),
          "御坂不知道为什么老是在自动更新房间");
        const roomBehaviorPassed = roomBehaviorReply?.requestPlan?.intent === "chat" &&
          roomBehaviorReply?.requestPlan?.memorySearch === false &&
          !!roomBehaviorReply?.finalReply &&
          !/(?:^|\n)咲(?:觉得|认为|感觉|想|知道|不知道|会|不会)/.test(
            roomBehaviorReply.finalReply);
        results.push({
          id: "current-room-behavior-stays-chat-and-keeps-misaka-identity",
          repetition,
          passed: roomBehaviorPassed,
          actual: roomBehaviorReply,
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
