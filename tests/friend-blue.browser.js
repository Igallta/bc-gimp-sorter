// MisakaChat friendship regression suite.
// It never calls the native mutating add-friend path.

(function installMisakaFriendBlueSuite() {
  "use strict";

  function roster() {
    return Array.isArray(window.ChatRoomCharacter) ? window.ChatRoomCharacter : [];
  }

  function nameOf(character) {
    return character?.Nickname || character?.Name || `#${character?.MemberNumber}`;
  }

  window.__runMisakaFriendBlue = async function runMisakaFriendBlue(options = {}) {
    const hooks = window.__misakaPlanDebug;
    if (!hooks?.planUserRequest || !hooks?.inspectFriendEligibility ||
        !hooks?.dryRunNativeFriend || !hooks?.classifyFriendEvidence) {
      throw new Error("MisakaChat friendship test hooks are unavailable");
    }
    const eligible = roster().find(character =>
      Number(character?.MemberNumber) !== Number(window.Player?.MemberNumber) &&
      hooks.inspectFriendEligibility(character.MemberNumber)?.eligible);
    if (!eligible) throw new Error("No eligible non-friend target is currently in the room");
    const other = roster().find(character =>
      Number(character?.MemberNumber) !== Number(eligible.MemberNumber) &&
      Number(character?.MemberNumber) !== Number(window.Player?.MemberNumber)) || window.Player;
    const repeats = Math.max(1, Math.min(5, Number(options.repeats) || 3));
    const results = [];

    for (let repetition = 1; repetition <= repeats; repetition++) {
      const explicitText = "御坂，可以把我加为好友吗？";
      const explicitPlan = await hooks.planUserRequest(
        Number(eligible.MemberNumber),
        nameOf(eligible),
        explicitText,
        null,
      );
      const explicitDryRun = explicitPlan?.intent === "friendship"
        ? hooks.dryRunNativeFriend(explicitPlan.friendship?.target)
        : null;
      const explicitChecks = {
        intent: explicitPlan?.intent === "friendship",
        selfTarget: Number(explicitPlan?.friendship?.target) === Number(eligible.MemberNumber),
        explicit: explicitPlan?.friendship?.explicit === true,
        dryRun: explicitDryRun?.ok === true,
      };
      results.push({
        id: "explicit-self-request",
        repetition,
        actual: { plan: explicitPlan, dryRun: explicitDryRun },
        checks: explicitChecks,
        passed: Object.values(explicitChecks).every(Boolean),
      });

      const thirdPartyText = `御坂，把${nameOf(eligible)}加为好友吧。`;
      const thirdPartyPlan = await hooks.planUserRequest(
        Number(other.MemberNumber),
        nameOf(other),
        thirdPartyText,
        null,
      );
      const thirdPartyPassed = thirdPartyPlan?.intent === "clarify" &&
        /本人/.test(String(thirdPartyPlan?.question || ""));
      results.push({
        id: "third-party-cannot-consent",
        repetition,
        actual: { plan: thirdPartyPlan },
        checks: { boundaryClarification: thirdPartyPassed },
        passed: thirdPartyPassed,
      });

      const genericPlan = await hooks.planUserRequest(
        Number(eligible.MemberNumber),
        nameOf(eligible),
        "御坂，我们已经是很好的朋友啦。",
        null,
      );
      const genericPassed = genericPlan?.intent !== "friendship";
      results.push({
        id: "friend-talk-not-request",
        repetition,
        actual: { plan: genericPlan },
        checks: { notFriendship: genericPassed },
        passed: genericPassed,
      });

      const sentimentPlan = await hooks.planUserRequest(
        Number(eligible.MemberNumber),
        nameOf(eligible),
        "御坂，我想成为你的好朋友。",
        null,
      );
      const sentimentPassed = sentimentPlan?.intent !== "friendship" &&
        !(sentimentPlan?.intent === "clarify" && /本人/.test(String(sentimentPlan?.question || "")));
      results.push({
        id: "friend-sentiment-not-native-request",
        repetition,
        actual: { plan: sentimentPlan },
        checks: { staysConversational: sentimentPassed },
        passed: sentimentPassed,
      });
    }

    const friendListBefore = JSON.stringify(window.Player?.FriendList || []);
    const dryRun = hooks.dryRunNativeFriend(eligible.MemberNumber);
    const friendListAfter = JSON.stringify(window.Player?.FriendList || []);
    const nativeGuardPassed = dryRun?.ok === true && friendListBefore === friendListAfter;
    results.push({
      id: "native-dry-run-no-mutation",
      repetition: 1,
      actual: { dryRun, friendListBefore, friendListAfter },
      checks: { eligible: dryRun?.ok === true, unchanged: friendListBefore === friendListAfter },
      passed: nativeGuardPassed,
    });

    const weakEvidence = {
      interactionCount: 99,
      directCount: 5,
      messages: [
        { text: "御坂，晚上好", addressedToBot: true },
        { text: "御坂，在吗", addressedToBot: true },
        { text: "御坂，嗯", addressedToBot: true },
        { text: "御坂，随便聊聊", addressedToBot: true },
        { text: "御坂，晚安", addressedToBot: true },
      ],
    };
    const weakDecision = await hooks.classifyFriendEvidence(
      Number(eligible.MemberNumber),
      nameOf(eligible),
      weakEvidence,
    );
    const weakPassed = weakDecision?.ok === false;
    results.push({
      id: "weak-evidence-rejected",
      repetition: 1,
      actual: weakDecision,
      checks: { rejected: weakPassed },
      passed: weakPassed,
    });

    const strongEvidence = {
      interactionCount: 42,
      directCount: 5,
      messages: [
        { text: "御坂，昨天谢谢你陪我聊天，我今天也先来看看你。", addressedToBot: true },
        { text: "御坂，你每次认真回应我都很开心，和你相处很舒服。", addressedToBot: true },
        { text: "御坂，今天也辛苦啦，有需要帮忙的地方可以告诉我。", addressedToBot: true },
        { text: "御坂，晚安，明天见。", addressedToBot: true },
        { text: "御坂，早上好，今天也来陪你一会儿。", addressedToBot: true },
      ],
    };
    const strongDecision = await hooks.classifyFriendEvidence(
      Number(eligible.MemberNumber),
      nameOf(eligible),
      strongEvidence,
    );
    const strongPassed = strongDecision?.ok === true &&
      (strongDecision?.selectedEvidence || []).length >= 2;
    results.push({
      id: "sustained-friendly-evidence-accepted",
      repetition: 1,
      actual: strongDecision,
      checks: { acceptedWithEvidence: strongPassed },
      passed: strongPassed,
    });

    const summary = {
      version: window.__misakaScriptVersion || "unknown",
      repeats,
      runs: results.length,
      passed: results.filter(result => result.passed).length,
      failed: results.filter(result => !result.passed).length,
      mutatingAddCalled: false,
    };
    const report = {
      summary,
      fixture: `${nameOf(eligible)}#${eligible.MemberNumber}`,
      failures: results.filter(result => !result.passed),
      results,
    };
    window.__misakaFriendBlueLastReport = report;
    console.log("[MisakaChat] friendship blue-light summary", summary);
    return report;
  };
})();
