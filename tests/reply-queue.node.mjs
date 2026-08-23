#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../misaka-chat.js", import.meta.url), "utf8");
const store = new Map();
const sent = [];
const localMessages = [];
const shadowEvents = [];
const timers = [];
let inputWrites = 0;

const context = {
  console, Date, Math, JSON, Number, String, Array, Object, Map, Set, Promise,
  RegExp, URL, TextEncoder, structuredClone,
  setTimeout(callback, delay) {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  },
  clearTimeout(timer) { if (timer) timer.cleared = true; },
  setInterval() { return 1; },
  clearInterval() {},
  navigator: {},
  CustomEvent: class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  },
  document: {
    readyState: "complete",
    dispatchEvent(event) { shadowEvents.push(structuredClone({ type: event.type, detail: event.detail })); },
  },
  localStorage: {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  },
  indexedDB: { open() { throw new Error("unexpected IndexedDB access"); } },
  Player: { MemberNumber: 194331, ChatSettings: {} },
  ChatRoomCharacter: [],
  CurrentScreen: "ChatRoom",
  ChatRoomGenerateChatRoomChatMessage(type, content) {
    return { Type: type, Content: content, Dictionary: [{ Tag: "SourceCharacter", MemberNumber: 194331 }] };
  },
  ChatRoomMessage(message) { localMessages.push(structuredClone(message)); },
  ServerSend(name, data) { sent.push({ name, data: structuredClone(data) }); },
  ChatRoomOwnerPresenceRule() { return false; },
  ChatRoomOwnerForbiddenWordCheck() { return true; },
  SpeechGetOOCRanges() { return []; },
  ChatRoomStimulationMessage() {},
  ElementValue() { inputWrites += 1; },
  ChatRoomSendChat() { throw new Error("native reply path must not use InputChat"); },
};
context.window = context;
context.__misakaShadowStatus = () => ({ enabled: true, configured: true, pending: 0 });
context.window.__misakaNextBootstrapOptions = { mode: "test" };
vm.runInNewContext(source, context, { filename: "misaka-chat.js" });

const hooks = context.__misakaPlanDebug;
assert.ok(hooks, "MisakaChat test hooks must be available");
hooks.replaceRecentMessagesForTest([
  { senderName: "铃", senderMemberNumber: 1001, content: "上一句", messageType: "Chat", time: 1 },
  { senderName: "咲", senderMemberNumber: 1002, content: "御坂，晚上好", messageType: "Chat", time: 2 },
]);
context.ChatRoomCharacter.push(
  { MemberNumber: 194331, Name: "御坂", Appearance: [] },
  { MemberNumber: 1001, Name: "铃", Appearance: [] },
  { MemberNumber: 1002, Name: "咲", Appearance: [] },
);
const shadowEvent = JSON.parse(JSON.stringify(hooks.buildShadowEventForTest({
  eventId: "shadow-runtime-test",
  createdAt: 3,
  receivedAt: 2,
  senderNum: 1002,
  senderName: "咲",
  content: "御坂，晚上好",
  replyId: "msg-shadow",
  messageType: "Chat",
})));
assert.equal(shadowEvent.protocol, "misaka.shadow-event.v1");
assert.equal(shadowEvent.context.length, 1, "latest triggering message must not be duplicated in context");
assert.equal(shadowEvent.projection.memberCount, 3);
assert.equal(shadowEvent.message.text, "御坂，晚上好");
context.ChatRoomCharacter.length = 0;
hooks.replaceRecentMessagesForTest([]);
assert.deepEqual(
  JSON.parse(JSON.stringify(hooks.inspectPendingReplyConfigForTest())),
  { max: 5, ttlMs: 300000 },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(hooks.inspectGeneratedReplyConfigForTest())),
  {
    attemptsPerGeneration: 1,
    plannerMaxTokens: 4096,
    hardTimeoutMs: 600000,
  },
);

assert.equal(hooks.extractMessageIdForTest({
  Dictionary: [{ Tag: "SourceCharacter" }, { Tag: "MsgId", MsgId: "msg-official-1" }],
}), "msg-official-1");
assert.equal(hooks.extractMessageIdForTest({ Dictionary: [] }), "");

hooks.resetPendingRepliesForTest();
hooks.setReplyBusyForTest(true);
context.ChatRoomCharacter.push(
  { MemberNumber: 301, Name: "A", Nickname: "A" },
  { MemberNumber: 302, Name: "B", Nickname: "B" },
  { MemberNumber: 303, Name: "C", Nickname: "C" },
  { MemberNumber: 304, Name: "D", Nickname: "D" },
  { MemberNumber: 305, Name: "E", Nickname: "E" },
  { MemberNumber: 306, Name: "F", Nickname: "F" },
);
for (let index = 1; index <= 6; index++) {
  hooks.receiveChatMessageForTest({
    Sender: 300 + index,
    Type: "Chat",
    Content: "御坂，同一句",
    Dictionary: [{ Tag: "MsgId", MsgId: `incoming-${index}` }],
  });
}
assert.equal(
  shadowEvents.filter(event => event.type === "misaka-shadow-event-v1").length,
  6,
  "shadow events must be emitted at trigger ingress even while legacy replies remain queued",
);
assert.equal(
  shadowEvents.filter(event => event.type === "misaka-shadow-legacy-v1" && event.detail.outcome === "queue-overflow").length,
  1,
  "an evicted legacy reply must close its shadow comparison record",
);
let queued = JSON.parse(JSON.stringify(hooks.snapshotPendingRepliesForTest()));
assert.deepEqual(queued.map(item => item.replyId), ["incoming-2", "incoming-3", "incoming-4", "incoming-5", "incoming-6"],
  "distinct BC message IDs must preserve repeated text while busy instead of disappearing");
hooks.setReplyBusyForTest(false);
hooks.resetPendingRepliesForTest();

const base = 1_000_000;
for (let index = 1; index <= 6; index++) {
  hooks.enqueuePendingReplyForTest({
    senderNum: 100 + index,
    senderName: `User ${index}`,
    content: `御坂，问题 ${index}`,
    messageType: "Chat",
    replyId: `msg-${index}`,
    receivedAt: base + index,
  }, base + index);
}
queued = JSON.parse(JSON.stringify(hooks.snapshotPendingRepliesForTest()));
assert.deepEqual(queued.map(item => item.replyId), ["msg-2", "msg-3", "msg-4", "msg-5", "msg-6"],
  "sixth message must drop the oldest and retain the latest five in FIFO order");
assert.deepEqual(queued.map(item => item.senderNum), [102, 103, 104, 105, 106],
  "cross-user order must be preserved");

assert.equal(hooks.enqueuePendingReplyForTest({
  senderNum: 999,
  senderName: "Duplicate relay",
  content: "不同包装但同一个消息 ID",
  messageType: "Chat",
  replyId: "msg-6",
  receivedAt: base + 7,
}, base + 7), false, "same BC message ID must be deduplicated");
assert.equal(hooks.snapshotPendingRepliesForTest().length, 5);

hooks.resetPendingRepliesForTest();
hooks.enqueuePendingReplyForTest({
  senderNum: 201,
  senderName: "Old",
  content: "御坂，旧问题",
  messageType: "Chat",
  replyId: "old-msg",
  receivedAt: base,
}, base);
hooks.enqueuePendingReplyForTest({
  senderNum: 202,
  senderName: "Fresh",
  content: "御坂，新问题",
  messageType: "Chat",
  replyId: "fresh-msg",
  receivedAt: base + 299_000,
}, base + 299_000);
hooks.purgeExpiredPendingRepliesForTest(base + 300_001);
queued = JSON.parse(JSON.stringify(hooks.snapshotPendingRepliesForTest()));
assert.deepEqual(queued.map(item => item.replyId), ["fresh-msg"],
  "messages older than five minutes must expire without blocking fresh work");

assert.equal(hooks.sendNativeReplyPartForTest("直接回答。", "msg-native-chat"), true);
assert.equal(hooks.sendNativeReplyPartForTest("*轻轻点头*", "msg-native-emote"), true);
assert.equal(inputWrites, 0, "native reply sending must not overwrite InputChat");
assert.equal(sent[0].name, "ChatRoomChat");
assert.equal(sent[0].data.Type, "Chat");
assert.deepEqual(
  sent[0].data.Dictionary.find(entry => entry.Tag === "ReplyId"),
  { ReplyId: "msg-native-chat", Tag: "ReplyId" },
);
assert.equal(sent[1].data.Type, "Emote");
assert.equal(sent[1].data.Content, "轻轻点头");
assert.deepEqual(
  sent[1].data.Dictionary.find(entry => entry.Tag === "ReplyId"),
  { ReplyId: "msg-native-emote", Tag: "ReplyId" },
);

sent.length = 0;
hooks.sendReplyForTest("*歪了歪头*\n怎么了？", "msg-two-part");
for (const timer of timers.splice(0)) {
  if (!timer.cleared) timer.callback();
}
assert.equal(sent.length, 2);
assert.equal(sent[0].data.Type, "Emote");
assert.equal(sent[0].data.Dictionary.some(entry => entry.Tag === "ReplyId"), false,
  "the action prelude should not duplicate the reply preview");
assert.equal(sent[1].data.Type, "Chat");
assert.deepEqual(
  sent[1].data.Dictionary.find(entry => entry.Tag === "ReplyId"),
  { ReplyId: "msg-two-part", Tag: "ReplyId" },
  "the spoken line must carry the native reply relation",
);

sent.length = 0;
hooks.sendReplyForTest("歪了歪头|怎么了？", "msg-literal-pipe");
for (const timer of timers.splice(0)) {
  if (!timer.cleared) timer.callback();
}
assert.equal(sent.length, 1, "a pipe must never split one reply into legacy action/speech parts");
assert.equal(sent[0].data.Type, "Chat");
assert.equal(sent[0].data.Content, "歪了歪头|怎么了？");

const rejectedLegacyText = hooks.inspectGeneratedReplyForTest("歪了歪头|怎么了？", "chat");
assert.equal(rejectedLegacyText.usable, false);
assert.equal(rejectedLegacyText.reason, "structured-reply-required");

const acceptedStructuredPipe = hooks.inspectGeneratedReplyForTest(JSON.stringify({
  protocol: "misaka.reply.v1",
  commands: [],
  action: "",
  speech: "歪了歪头|怎么了？",
}), "chat");
assert.equal(acceptedStructuredPipe.usable, true);
assert.equal(acceptedStructuredPipe.parsed.cleaned, "歪了歪头|怎么了？");

const rejectedLegacyMemoryCommand = hooks.inspectGeneratedReplyForTest(JSON.stringify({
  protocol: "misaka.reply.v1",
  commands: [{ type: "memsearch", query: "旧问题" }],
  action: "",
  speech: "",
}), "chat");
assert.equal(rejectedLegacyMemoryCommand.usable, false);
assert.equal(rejectedLegacyMemoryCommand.reason, "invalid-command-envelope");

for (const speech of ["第一行\n第二行", "*不应自行加星号*"]) {
  const rejectedVisibleFormat = hooks.inspectGeneratedReplyForTest(JSON.stringify({
    protocol: "misaka.reply.v1",
    commands: [],
    action: "",
    speech,
  }), "chat");
  assert.equal(rejectedVisibleFormat.usable, false);
  assert.equal(rejectedVisibleFormat.reason, "invalid-visible-field-format");
}

sent.length = 0;
assert.match(hooks.generationFailureReplyForTest(), /咲/);
assert.equal(hooks.sendGenerationFailureForTest("msg-generation-failed"), true);
assert.equal(sent.length, 1);
assert.match(sent[0].data.Content, /御坂.*咲/);
assert.deepEqual(
  sent[0].data.Dictionary.find(entry => entry.Tag === "ReplyId"),
  { ReplyId: "msg-generation-failed", Tag: "ReplyId" },
  "the single-attempt failure notice must reply to the task that failed",
);

for (const name of ["GIMP 001", "Gimp 1001", "Doll 441", "GIMP Pet 104", "Pet 777", "Error 795"]) {
  assert.equal(hooks.isDollNameForTest(name), true, `${name} must be classified as a doll`);
}
for (const name of ["GIMP 12", "Error 12345", "Player 123"]) {
  assert.equal(hooks.isDollNameForTest(name), false, `${name} must remain a player name`);
}
assert.equal(hooks.semanticMemoryLimitForTest(), 5000);
assert.equal(hooks.containsEmbeddedOperationTagForTest("普通回复|ω･)"), false);
assert.equal(hooks.containsEmbeddedOperationTagForTest("[ITEMADD:123:BallGag]"), true);
assert.equal(hooks.containsEmbeddedOperationTagForTest("[UNKNOWN_ACTION:payload]"), true);
context.navigator.userAgent = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)";
context.navigator.maxTouchPoints = 5;
assert.equal(hooks.semanticMemoryLimitForTest(), 1000);
context.navigator.userAgent = "";
context.navigator.maxTouchPoints = 0;

hooks.replaceSemanticMemoriesForTest(Array.from({ length: 60 }, (_, index) => ({
  id: index + 1,
  text: `memory-${index}`,
  time: Date.now() - index * 1000,
  embedding: [index],
})));
assert.equal(await hooks.smartForgetForTest(10), 50);
assert.equal(hooks.inspectLifecycleForTest().semanticMemories, 10);
hooks.replaceSemanticMemoriesForTest([]);

assert.equal(hooks.handleCommandForTest("/misaka off"), true);
assert.equal(hooks.inspectRuntimeSettingsForTest().enabled, false);
assert.equal(store.get("misaka_enabled"), "false");
assert.equal(hooks.handleCommandForTest("/misaka on"), true);
assert.equal(hooks.inspectRuntimeSettingsForTest().enabled, true);
assert.equal(store.get("misaka_enabled"), "true");

const gmSecrets = new Map();
context.__GM_getValue = key => gmSecrets.get(key);
context.__GM_setValue = (key, value) => {
  gmSecrets.set(key, value);
  return true;
};
store.set("misaka_apikey", "stale-local-key");
assert.equal(hooks.migrateStoredSecretForTest("misaka_apikey"), true);
assert.equal(gmSecrets.get("misaka_apikey"), "stale-local-key");
assert.equal(store.has("misaka_apikey"), false);
assert.equal(hooks.handleCommandForTest("/misaka key replacement-chat-key"), true);
assert.equal(gmSecrets.get("misaka_apikey"), "replacement-chat-key");
assert.equal(store.has("misaka_apikey"), false);
assert.equal(hooks.handleCommandForTest("/misaka embedkey replacement-embed-key"), true);
assert.equal(gmSecrets.get("misaka_openrouter_key"), "replacement-embed-key");
assert.equal(store.has("misaka_openrouter_key"), false);

localMessages.length = 0;
assert.equal(hooks.handleCommandForTest("/misaka status"), true);
assert.equal(localMessages.length, 1);
assert.match(localMessages[0].Content, /\[MisakaChat\] 状态：开启 \| 原生互动：开启/);
assert.doesNotMatch(localMessages[0].Content, /版本：|Loader：|对话Key：|Embedding：/);

localMessages.length = 0;
assert.equal(hooks.handleCommandForTest("/misaka diag"), true);
assert.equal(localMessages.length, 1);
assert.match(localMessages[0].Content, /\[MisakaChat\] 运行时：3\.3\.2 \| Loader：未知/);
assert.match(localMessages[0].Content, /Embedding：OpenRouter Voyage 4 Large\/voyageai\/voyage-4-large\/1024维/);

gmSecrets.delete("misaka_openrouter_key");
localMessages.length = 0;
assert.equal(hooks.handleCommandForTest("/misaka diag"), true);
assert.equal(localMessages.length, 2);
assert.match(localMessages[1].Content, /语义记忆不可用.*对话仍可运行.*不会写入或召回向量记忆/);

context.__misakaTestLifecycle.dispose("reply-queue-suite-complete");
console.log("MisakaChat reply queue/native reply regression: PASS");
