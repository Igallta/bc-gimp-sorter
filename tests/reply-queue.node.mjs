#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../misaka-chat.js", import.meta.url), "utf8");
const store = new Map();
const sent = [];
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
  document: { readyState: "complete" },
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
  ServerSend(name, data) { sent.push({ name, data: structuredClone(data) }); },
  ChatRoomOwnerPresenceRule() { return false; },
  ChatRoomOwnerForbiddenWordCheck() { return true; },
  SpeechGetOOCRanges() { return []; },
  ChatRoomStimulationMessage() {},
  ElementValue() { inputWrites += 1; },
  ChatRoomSendChat() { throw new Error("native reply path must not use InputChat"); },
};
context.window = context;
context.window.__misakaNextBootstrapOptions = { mode: "test" };
vm.runInNewContext(source, context, { filename: "misaka-chat.js" });

const hooks = context.__misakaPlanDebug;
assert.ok(hooks, "MisakaChat test hooks must be available");
assert.deepEqual(
  JSON.parse(JSON.stringify(hooks.inspectPendingReplyConfigForTest())),
  { max: 5, ttlMs: 300000 },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(hooks.inspectGeneratedReplyConfigForTest())),
  {
    maxAttempts: 2,
    retryDelaysMs: [2000],
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

const validReply = JSON.stringify({
  protocol: "misaka.reply.v1",
  commands: [],
  action: "轻轻点头",
  speech: "这次生成出来了。",
});
const secondAttemptSuccess = await hooks.retryGeneratedReplyForTest([
  "   \n",
  validReply,
]);
assert.equal(secondAttemptSuccess.reply, validReply);
assert.equal(secondAttemptSuccess.attempts, 2);
assert.equal(secondAttemptSuccess.exhausted, false,
  "a usable second response must complete the current task instead of failing it");

const exhausted = await hooks.retryGeneratedReplyForTest(["", " \n"]);
assert.equal(exhausted.reply, "");
assert.equal(exhausted.attempts, 2);
assert.equal(exhausted.exhausted, true,
  "two unusable responses must exhaust the task and allow the queue to continue");

sent.length = 0;
assert.match(hooks.generationFailureReplyForTest(), /咲/);
assert.equal(hooks.sendGenerationFailureForTest("msg-generation-failed"), true);
assert.equal(sent.length, 1);
assert.match(sent[0].data.Content, /御坂.*咲/);
assert.deepEqual(
  sent[0].data.Dictionary.find(entry => entry.Tag === "ReplyId"),
  { ReplyId: "msg-generation-failed", Tag: "ReplyId" },
  "the two-attempt failure notice must reply to the task that failed",
);

context.__misakaTestLifecycle.dispose("reply-queue-suite-complete");
console.log("MisakaChat reply queue/native reply regression: PASS");
