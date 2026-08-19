#!/usr/bin/env node

import fs from "node:fs";
import vm from "node:vm";

const chatSource = fs.readFileSync(new URL("../misaka-chat.js", import.meta.url), "utf8");
const suiteSource = fs.readFileSync(new URL("./context-blue.browser.js", import.meta.url), "utf8");
const store = new Map();

const groupNames = ["ItemDevices", "ItemHandheld", "ItemArms"];
const groups = groupNames.map(Name => ({ Name, Family: "Female3DCG" }));
const groupByName = new Map(groups.map(group => [group.Name, group]));
const assets = [
  { Name: "PetBed", Description: "宠物床", Group: groupByName.get("ItemDevices") },
  { Name: "Hairbrush", Description: "梳子", Group: groupByName.get("ItemHandheld") },
  { Name: "HempRope", Description: "麻绳", Group: groupByName.get("ItemArms") },
];

const context = {
  console, Date, Math, JSON, Number, String, Array, Object, Map, Set, Promise,
  RegExp, URL, TextEncoder, structuredClone, performance, crypto: globalThis.crypto,
  setTimeout, clearTimeout, queueMicrotask,
  setInterval() { return 1; },
  clearInterval() {},
  navigator: { onLine: true },
  document: {
    readyState: "complete",
    querySelector() { return null; },
    getElementById() { return null; },
  },
  localStorage: {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  },
  indexedDB: { open() { throw new Error("unexpected IndexedDB access"); } },
  Player: {
    MemberNumber: 194331,
    Name: "御搬",
    Nickname: "御搬",
    AssetFamily: "Female3DCG",
    ChatSettings: {},
    Appearance: [],
    FriendList: [],
  },
  ChatRoomCharacter: [
    { MemberNumber: 910001, Name: "TEST_A", Nickname: "Test A", AssetFamily: "Female3DCG", Appearance: [] },
    { MemberNumber: 910002, Name: "TEST_B", Nickname: "Test B", AssetFamily: "Female3DCG", Appearance: [] },
    { MemberNumber: 910003, Name: "TEST_C", Nickname: "Test C", AssetFamily: "Female3DCG", Appearance: [] },
  ],
  ChatRoomData: { Name: "Misaka deterministic fixture" },
  CurrentScreen: "ChatRoom",
  Asset: assets,
  AssetGroup: groups,
  AssetGet(family, groupName, assetName) {
    return assets.find(asset => asset.Group?.Name === groupName && asset.Name === assetName) || null;
  },
  TranslationCache: {},
  InventoryGet() { return null; },
  CharacterRefresh() {},
  CharacterAppearanceBuildCanvas() {},
  ChatRoomCharacterUpdate() {},
  ChatRoomOwnerPresenceRule() { return false; },
  ChatRoomOwnerForbiddenWordCheck() { return true; },
  SpeechGetOOCRanges() { return []; },
  ChatRoomStimulationMessage() {},
  ElementValue() {},
  ChatRoomSendChat() {},
  XMLHttpRequest: class UnusedXHR {},
  __GM_getValue(key) { return key === "misaka_apikey" ? "test-only-key" : ""; },
};
context.window = context;
context.window.__misakaNextBootstrapOptions = { mode: "test" };

vm.runInNewContext(chatSource, context, { filename: "misaka-chat.js" });
vm.runInNewContext(suiteSource, context, { filename: "context-blue.browser.js" });
const report = await context.__runMisakaContextBlue({ deterministicOnly: true });
process.stdout.write(`${JSON.stringify(report.summary)}\n`);
if (report.failures.length) {
  process.stdout.write(`${JSON.stringify(report.failures, null, 2)}\n`);
  process.exitCode = 1;
}
context.__misakaTestLifecycle.dispose("context-node-suite-complete");
