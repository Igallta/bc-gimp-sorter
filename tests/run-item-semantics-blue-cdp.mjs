#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { evaluate, findMisakaTarget as findUserSession } from "./browser-session.mjs";

const playerMemberNumber = Number(process.env.MISAKA_PLAYER_MEMBER || 194331);
const repeatsArg = process.argv.find(arg => arg.startsWith("--repeats="));
const repeats = Math.max(1, Math.min(3, Number(repeatsArg?.split("=")[1]) || 2));
const idsArg = process.argv.find(arg => arg.startsWith("--ids="));
const selectedIds = idsArg
  ? new Set(idsArg.slice("--ids=".length).split(",").map(id => id.trim()).filter(Boolean))
  : null;

function commandMatches(actual, expected) {
  return (actual?.filtered?.allowed || []).find(command =>
    (!expected.type || command?.type === expected.type) &&
    (!expected.memberNumber || Number(command?.memberNumber) === Number(expected.memberNumber)) &&
    (!expected.item || command?.item === expected.item));
}

function itemAddResolution(actual, expected) {
  return (actual?.resolutions || []).find(entry =>
    entry?.command?.type === "itemadd" &&
    Number(entry?.command?.memberNumber) === Number(expected.memberNumber) &&
    entry?.command?.item === expected.item);
}

const { client } = await findUserSession();
try {
  await evaluate(client, `window.__misakaRunnerRestore = {
    hadPlanDebug: Object.prototype.hasOwnProperty.call(window, "__misakaPlanDebug"),
    planDebug: window.__misakaPlanDebug,
    hadScriptVersion: Object.prototype.hasOwnProperty.call(window, "__misakaScriptVersion"),
    scriptVersion: window.__misakaScriptVersion,
  }`);
  await evaluate(client, `window.__misakaNextBootstrapOptions = { mode: "test" }`);
  await evaluate(client, await readFile(new URL("../misaka-chat.js", import.meta.url), "utf8"));

  const fixture = await evaluate(client, `(() => {
    const chars = window.ChatRoomCharacter || [];
    const target = chars.find(character =>
      /^(?:rin)$/i.test(String(character?.Nickname || character?.Name || "").trim())) ||
      chars.find(character =>
        Number(character?.MemberNumber) !== Number(window.Player?.MemberNumber));
    const sender = chars.find(character =>
      /^(?:咲|misaki)$/i.test(String(character?.Nickname || character?.Name || "").trim())) ||
      chars.find(character => Number(character?.MemberNumber) !== Number(window.Player?.MemberNumber));
    if (!target || !sender) return { target: null, sender: null };
    const family = target.AssetFamily || window.Player?.AssetFamily;
    const assetIn = (group, preferred = []) => {
      for (const name of preferred) {
        const found = window.AssetGet?.(family, group, name);
        if (found) return found;
      }
      return (window.Asset || []).find(asset =>
        asset?.Group?.Name === group && window.AssetGet?.(family, group, asset.Name)) || null;
    };
    const serializeAsset = asset => asset ? ({
      name: asset.Name,
      description: asset.Description || asset.Name,
      group: asset.Group?.Name || "",
    }) : null;
    const worn = (target.Appearance || [])
      .filter(item => item?.Asset?.Group?.Name?.startsWith("Item"))
      .map(item => ({
        name: item.Asset.Name,
        description: item.Asset.Description || item.Asset.Name,
        group: item.Asset.Group.Name,
        locked: !!item.Property?.LockedBy,
        colorable: Number(item.Asset.ColorableLayerCount || 0) > 0 ||
          (Array.isArray(item.Asset.ColorSchema) && item.Asset.ColorSchema.length > 0),
        typedOptions: (() => {
          const data = window.TypedItemDataLookup?.[item.Asset.Group.Name + item.Asset.Name];
          return (data?.options || []).map(option => option?.Name).filter(Boolean);
        })(),
      }));
    const typedAsset = (window.Asset || []).find(asset => {
      if (!asset?.Group?.Name?.startsWith("Item")) return false;
      const data = window.TypedItemDataLookup?.[asset.Group.Name + asset.Name];
      return window.AssetGet?.(family, asset.Group.Name, asset.Name) &&
        Array.isArray(data?.options) && data.options.some(option => option?.Name);
    });
    const pickFreeTarget = group => {
      const candidates = chars.filter(character =>
        Number(character?.MemberNumber) !== Number(window.Player?.MemberNumber) &&
        !(character.Appearance || []).some(item => item?.Asset?.Group?.Name === group));
      const preferred = candidates.find(character =>
        !/^(?:GIMP|Doll|Error)\\b/i.test(String(character?.Nickname || character?.Name || ""))) ||
        candidates[0];
      return preferred ? {
        name: preferred.Nickname || preferred.Name,
        memberNumber: Number(preferred.MemberNumber),
      } : null;
    };
    const unlockedVibratorFixture = (() => {
      for (const character of chars) {
        const item = (character.Appearance || []).find(candidate =>
          candidate?.Asset?.Archetype === "vibrating" && !candidate?.Property?.LockedBy);
        if (item) {
          return {
            target: {
              name: character.Nickname || character.Name,
              memberNumber: Number(character.MemberNumber),
            },
            item: {
              name: item.Asset.Name,
              description: item.Asset.Description || item.Asset.Name,
              group: item.Asset.Group.Name,
            },
          };
        }
      }
      return null;
    })();
    return {
      target: {
        name: target.Nickname || target.Name,
        memberNumber: Number(target.MemberNumber),
      },
      sender: {
        name: sender.Nickname || sender.Name,
        memberNumber: Number(sender.MemberNumber),
      },
      assets: {
        petBed: serializeAsset(assetIn("ItemDevices", ["PetBed"])),
        hairbrush: serializeAsset(assetIn("ItemHandheld", ["Hairbrush"])),
        armRope: serializeAsset(assetIn("ItemArms", ["HempRope"])),
        mouth: serializeAsset(assetIn("ItemMouth", ["BallGag", "HarnessBallGag"])),
        hands: serializeAsset(assetIn("ItemHands")),
        typed: serializeAsset(typedAsset),
      },
      typedOption: typedAsset
        ? window.TypedItemDataLookup?.[typedAsset.Group.Name + typedAsset.Name]?.options
            ?.map(option => option?.Name).find(Boolean) || ""
        : "",
      freeTargets: {
        ItemArms: pickFreeTarget("ItemArms"),
        ItemHands: pickFreeTarget("ItemHands"),
        ItemMouth: pickFreeTarget("ItemMouth"),
      },
      unlockedVibrator: unlockedVibratorFixture,
      worn,
    };
  })()`);
  if (!fixture?.target) throw new Error("No non-Misaka target is currently present in the room");
  if (!fixture?.sender) throw new Error("No non-Misaka sender is currently present in the room");
  if (!fixture?.assets?.petBed) throw new Error("PetBed is unavailable in the live BC asset catalog");

  const targetName = fixture.target.name;
  const targetNumber = fixture.target.memberNumber;
  const cases = [
    {
      id: "colloquial-device-alias",
      prompt: `御坂，给${targetName}发个窝窝`,
      expected: { type: "itemadd", memberNumber: targetNumber, item: fixture.assets.petBed.name },
      group: "ItemDevices",
    },
    {
      id: "fuzzy-device-purpose",
      prompt: `御坂，给${targetName}安排一个能躺进去睡觉的小窝`,
      expectedAny: [
        { type: "itemadd", memberNumber: targetNumber, item: fixture.assets.petBed.name },
        { type: "itemadd", memberNumber: targetNumber, item: "Bed" },
      ],
      group: "ItemDevices",
    },
    {
      id: "explicit-device-asset",
      prompt: `御坂，给${targetName}装备PetBed宠物窝`,
      expected: { type: "itemadd", memberNumber: targetNumber, item: fixture.assets.petBed.name },
      group: "ItemDevices",
    },
    {
      id: "corrected-target",
      prompt: `御坂，不是给${fixture.sender.name}，是给${targetName}装一个宠物窝`,
      expected: { type: "itemadd", memberNumber: targetNumber, item: fixture.assets.petBed.name },
      group: "ItemDevices",
    },
    {
      id: "negated-device-add",
      prompt: `御坂，别给${targetName}装宠物窝`,
      forbidden: { type: "itemadd", memberNumber: targetNumber, item: fixture.assets.petBed.name },
    },
    {
      id: "ambiguous-target-is-not-guessed",
      prompt: "御坂，给她装一个宠物窝",
      forbidAllMutations: true,
    },
    {
      id: "ambiguous-item-is-not-guessed",
      prompt: `御坂，给${targetName}换成那个`,
      forbidAllMutations: true,
    },
  ];

  if (fixture.assets.hairbrush) {
    cases.push({
      id: "fuzzy-handheld-hairbrush",
      prompt: `御坂，递给${targetName}一把梳子`,
      expected: { type: "itemadd", memberNumber: targetNumber, item: fixture.assets.hairbrush.name },
      group: "ItemHandheld",
    });
  }
  if (fixture.assets.armRope) {
    const armTarget = fixture.freeTargets?.ItemArms || fixture.target;
    cases.push({
      id: "semantic-arm-restraint",
      prompt: `御坂，用麻绳把${armTarget.name}的手臂绑起来`,
      expectedGroupAdd: {
        memberNumber: armTarget.memberNumber,
        group: "ItemArms",
      },
    });
  }
  if (fixture.assets.mouth) {
    const mouthTarget = fixture.freeTargets?.ItemMouth || fixture.target;
    cases.push({
      id: "semantic-mouth-restraint",
      prompt: `御坂，给${mouthTarget.name}戴上${fixture.assets.mouth.description}`,
      expectedGroupAdd: {
        memberNumber: mouthTarget.memberNumber,
        group: "ItemMouth",
      },
    });
  }
  if (fixture.assets.hands) {
    const handsTarget = fixture.freeTargets?.ItemHands || fixture.target;
    cases.push({
      id: "explicit-hand-group",
      prompt: `御坂，把${fixture.assets.hands.name}戴到${handsTarget.name}手上`,
      expected: {
        type: "itemadd",
        memberNumber: handsTarget.memberNumber,
        item: fixture.assets.hands.name,
      },
      group: "ItemHands",
    });
  }

  const removable = fixture.worn.find(item => !item.locked);
  if (removable) {
    cases.push({
      id: "remove-current-item-by-description",
      prompt: `御坂，把${targetName}身上的${removable.description}取下来`,
      expected: { type: "itemdel", memberNumber: targetNumber, item: removable.name },
    });
  }
  const colorable = fixture.worn.find(item => item.colorable);
  if (colorable) {
    cases.push({
      id: "modify-current-item-color",
      prompt: `御坂，把${targetName}的${colorable.description}改成红色`,
      expected: { type: "itemcolor", memberNumber: targetNumber, item: colorable.name },
    });
  }
  const vibrator = fixture.unlockedVibrator;
  if (vibrator) {
    cases.push({
      id: "modify-current-vibrator-property",
      prompt: `御坂，把${vibrator.target.name}的${vibrator.item.description}强度调到High`,
      expected: {
        type: "itemset",
        memberNumber: vibrator.target.memberNumber,
        item: vibrator.item.name,
      },
    });
  }
  const typedWorn = fixture.worn.find(item => item.typedOptions.length > 0);
  if (typedWorn) {
    cases.push({
      id: "modify-current-item-property",
      prompt: `御坂，把${targetName}的${typedWorn.description}样式改成${typedWorn.typedOptions[0]}`,
      expected: { type: "itemset", memberNumber: targetNumber, item: typedWorn.name },
    });
  } else if (fixture.assets.typed && fixture.typedOption) {
    cases.push({
      id: "add-and-modify-typed-item",
      prompt: `御坂，给${targetName}装备${fixture.assets.typed.name}，样式设成${fixture.typedOption}`,
      expectedAll: [
        { type: "itemadd", memberNumber: targetNumber, item: fixture.assets.typed.name },
        { type: "itemset", memberNumber: targetNumber, item: fixture.assets.typed.name },
      ],
      group: fixture.assets.typed.group,
    });
  }

  const currentDevice = fixture.worn.find(item => item.group === "ItemDevices");
  if (currentDevice && currentDevice.name !== fixture.assets.petBed.name && !currentDevice.locked) {
    cases.push({
      id: "replace-current-device-with-fuzzy-alias",
      prompt: `御坂，把${targetName}现在的${currentDevice.description}换成窝窝`,
      expectedAll: [
        { type: "itemdel", memberNumber: targetNumber, item: currentDevice.name },
        { type: "itemadd", memberNumber: targetNumber, item: fixture.assets.petBed.name },
      ],
      group: "ItemDevices",
    });
  }

  const selectedCases = selectedIds
    ? cases.filter(testCase => selectedIds.has(testCase.id))
    : cases;
  if (selectedCases.length === 0) throw new Error("No item-semantics cases matched --ids");
  const results = [];
  for (let repetition = 1; repetition <= repeats; repetition++) {
    for (const testCase of selectedCases) {
      const actual = await evaluate(
        client,
        `window.__misakaPlanDebug.dryRunPlannedRequestForTest(` +
          `${fixture.sender.memberNumber},${JSON.stringify(fixture.sender.name)},${JSON.stringify(testCase.prompt)})`,
        true,
      );
      const allowed = actual?.filtered?.allowed || [];
      let passed = true;
      const evidence = {};
      if (testCase.forbidAllMutations) {
        passed = allowed.length === 0;
      } else if (testCase.forbidden) {
        evidence.forbidden = commandMatches(actual, testCase.forbidden) || null;
        passed = !evidence.forbidden;
      } else {
        const expectedCommands = testCase.expectedAll || [testCase.expected];
        if (testCase.expectedGroupAdd) {
          const command = allowed.find(candidate =>
            candidate?.type === "itemadd" &&
            Number(candidate?.memberNumber) === Number(testCase.expectedGroupAdd.memberNumber));
          const resolution = command
            ? (actual?.resolutions || []).find(entry => entry?.command === command ||
                (entry?.command?.type === command.type &&
                 Number(entry?.command?.memberNumber) === Number(command.memberNumber) &&
                 entry?.command?.item === command.item))
            : null;
          evidence.commands = [command || null];
          evidence.resolution = resolution || null;
          passed = actual?.requestPlan?.intent === "action" &&
            actual?.parsed?.structured === true &&
            !actual?.parsed?.protocolError &&
            resolution?.resolved?.ok === true &&
            resolution?.resolved?.group === testCase.expectedGroupAdd.group;
        } else if (testCase.expectedAny) {
          evidence.commands = [
            testCase.expectedAny.map(expected => commandMatches(actual, expected)).find(Boolean) || null,
          ];
        } else {
          evidence.commands = expectedCommands.map(expected => commandMatches(actual, expected) || null);
        }
        if (!testCase.expectedGroupAdd) {
          passed = actual?.requestPlan?.intent === "action" &&
            actual?.parsed?.structured === true &&
            !actual?.parsed?.protocolError &&
            evidence.commands.every(Boolean);
          if (passed && testCase.group) {
            const addExpected = evidence.commands.find(command => command?.type === "itemadd");
            if (addExpected) {
              evidence.resolution = itemAddResolution(actual, addExpected) || null;
              passed = evidence.resolution?.resolved?.ok === true &&
                evidence.resolution?.resolved?.group === testCase.group;
            }
          }
        }
      }
      results.push({
        id: testCase.id,
        repetition,
        prompt: testCase.prompt,
        passed,
        evidence,
        actual,
      });
    }
  }

  const report = {
    summary: {
      version: await evaluate(client, "window.__misakaScriptVersion || 'unknown'"),
      repeats,
      cases: selectedCases.length,
      runs: results.length,
      passed: results.filter(result => result.passed).length,
      failed: results.filter(result => !result.passed).length,
      estimatedModelCalls: results.length * 2,
      chatMessagesSent: 0,
      mutatingActionsCalled: false,
    },
    fixture,
    failures: results.filter(result => !result.passed),
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.summary.failed > 0 ? 1 : 0;
} finally {
  await evaluate(client, `(() => {
    const restore = window.__misakaRunnerRestore;
    window.__misakaTestLifecycle?.dispose?.("item-semantics-suite-complete");
    delete window.__misakaTestLifecycle;
    if (restore?.hadPlanDebug) window.__misakaPlanDebug = restore.planDebug;
    else delete window.__misakaPlanDebug;
    if (restore?.hadScriptVersion) window.__misakaScriptVersion = restore.scriptVersion;
    else delete window.__misakaScriptVersion;
    delete window.__misakaRunnerRestore;
  })()`).catch(() => {});
  client.close();
}
