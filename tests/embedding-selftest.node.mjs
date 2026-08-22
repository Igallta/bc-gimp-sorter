#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../misaka-chat.js", import.meta.url), "utf8");
const store = new Map();
const gmSecrets = new Map([
  ["misaka_apikey", "test-chat-key"],
  ["misaka_openrouter_key", "test-embedding-key"],
]);

const context = {
  console, Date, Math, JSON, Number, String, Array, Object, Map, Set, Promise,
  RegExp, URL, TextEncoder, structuredClone,
  setTimeout() { return 1; },
  clearTimeout() {},
  setInterval() { return 1; },
  clearInterval() {},
  navigator: { userAgent: "iPad", platform: "MacIntel", maxTouchPoints: 5 },
  location: { origin: "https://example.bondage-europe.com" },
  document: { readyState: "complete" },
  localStorage: {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  },
  indexedDB: { open() { throw new Error("selftest unit must use injected IDB probe"); } },
  Player: { MemberNumber: 194331, ChatSettings: {} },
  ChatRoomCharacter: [],
  CurrentScreen: "ChatRoom",
  ChatRoomMessage() {},
  ChatRoomGenerateChatRoomChatMessage(type, content) { return { Type: type, Content: content, Dictionary: [] }; },
  ServerSend() {},
  ChatRoomOwnerPresenceRule() { return false; },
  ChatRoomOwnerForbiddenWordCheck() { return true; },
  SpeechGetOOCRanges() { return []; },
  ChatRoomStimulationMessage() {},
  __GM_getValue(key) { return gmSecrets.get(key); },
  __GM_setValue(key, value) { gmSecrets.set(key, value); return true; },
};
context.window = context;
context.window.__misakaNextBootstrapOptions = { mode: "test" };
vm.runInNewContext(source, context, { filename: "misaka-chat.js" });

const hooks = context.__misakaPlanDebug;
assert.ok(hooks, "MisakaChat test hooks must be available");
assert.deepEqual(JSON.parse(JSON.stringify(hooks.inspectEmbeddingConfigForTest())), [{
  name: "OpenRouter Voyage 4 Large",
  base: "https://openrouter.ai/api/v1/embeddings",
  model: "voyageai/voyage-4-large",
  keyNames: ["misaka_openrouter_key"],
  dimensions: 1024,
  queryInputType: "query",
  documentInputType: "document",
}]);
assert.deepEqual(JSON.parse(JSON.stringify(hooks.inspectEmbeddingBodyForTest("query", "query"))), {
  model: "voyageai/voyage-4-large",
  input: "query",
  input_type: "query",
  dimensions: 1024,
});
assert.deepEqual(JSON.parse(JSON.stringify(hooks.inspectEmbeddingBodyForTest("document", "document"))), {
  model: "voyageai/voyage-4-large",
  input: "document",
  input_type: "document",
  dimensions: 1024,
});

const passingReport = await hooks.runSelftestForTest({
  strictReplyProbe: async () => ({ ok: true }),
  embeddingQueryProbe: async () => ({ ok: true, dimensions: 1024 }),
  embeddingDocumentProbe: async () => ({ ok: true, dimensions: 1024 }),
  idbProbe: async () => ({ ok: true, wrote: true, read: true, deleted: true }),
  storageProbe: async () => ({ ok: true, supported: true, usageBytes: 1, quotaBytes: 2, persisted: false }),
});
assert.equal(passingReport.protocol, "misaka.selftest.v1");
assert.equal(passingReport.ok, true);
assert.equal(passingReport.embedding.model, "voyageai/voyage-4-large");
assert.equal(passingReport.embedding.dimensions, 1024);
assert.equal(passingReport.embedding.limit, 1000, "iPad selftest must report the iPad memory cap");
assert.equal(passingReport.checks.length, 8);
assert.ok(passingReport.checks.every(check => check.ok));
assert.equal(passingReport.uploadQueued, false, "unit mode must never enqueue a diagnostic upload");
assert.equal(JSON.parse(context.__misakaSelftestReport).protocol, "misaka.selftest.v1");

hooks.replaceSemanticMemoriesForTest([{ text: "legacy", time: Date.now(), embedding: new Array(3072).fill(0) }]);
const legacyVectorReport = await hooks.runSelftestForTest({
  strictReplyProbe: async () => ({ ok: true }),
  embeddingQueryProbe: async () => ({ ok: true, dimensions: 1024 }),
  embeddingDocumentProbe: async () => ({ ok: true, dimensions: 1024 }),
  idbProbe: async () => ({ ok: true, wrote: true, read: true, deleted: true }),
  storageProbe: async () => ({ ok: true, supported: true, usageBytes: 1, quotaBytes: 2, persisted: false }),
});
assert.equal(legacyVectorReport.ok, false);
assert.equal(legacyVectorReport.checks.find(check => check.id === "stored-vector-dimensions")?.ok, false);
hooks.replaceSemanticMemoriesForTest([]);

const failingReport = await hooks.runSelftestForTest({
  strictReplyProbe: async () => ({ ok: true }),
  embeddingQueryProbe: async () => ({ ok: true, dimensions: 1024 }),
  embeddingDocumentProbe: async () => ({ ok: false, dimensions: 0 }),
  idbProbe: async () => ({ ok: true, wrote: true, read: true, deleted: true }),
  storageProbe: async () => ({ ok: true, supported: true, usageBytes: 1, quotaBytes: 2, persisted: false }),
});
assert.equal(failingReport.ok, false);
assert.equal(failingReport.checks.find(check => check.id === "embedding-document")?.ok, false);

context.__misakaTestLifecycle.dispose("embedding-selftest-suite-complete");
console.log("Misaka Voyage embedding and selftest regression: PASS");
