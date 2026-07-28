# MisakaChat tests

## Memory blue-light browser suite

`memory-blue.browser.js` exercises the real v2.10.17 planning and memory-recall
chain inside an active Bondage Club page. It uses the read-only hooks exposed at
`window.__misakaPlanDebug` and does not:

- send room messages;
- mutate character state;
- write profiles;
- write `semantic_mem` or `refined_mem`.

Run the script in the BC page, then execute:

```js
await window.__runMisakaMemoryBlue({ repeats: 3 })
```

The report is returned and retained at:

```js
window.__misakaMemoryBlueLastReport
```

With the CDP Chrome already running, the repository runner hot-loads the local
candidate and runs the suite without touching the page UI:

```bash
node tests/run-memory-blue-cdp.mjs --repeats=3
```

It exits non-zero when any case fails and prints the complete JSON report.
Individual cases can be repeated during diagnosis:

```bash
node tests/run-memory-blue-cdp.mjs --repeats=5 --ids=past-rikka-confirm
```

The suite measures:

- recall: past questions that correctly enter memory search;
- specificity: current/opinion/roleplay requests that correctly skip memory;
- answer accuracy: expected `supported`/`insufficient` status and essential
  facts in the final reply.

The cases deliberately include positive memories that still exist as raw
semantic evidence, unsupported causal questions, a fabricated event,
current-state questions and roleplay. Do not make a test expect `supported`
only because a fact once existed in `refined_mem`: refined facts are
intentionally bounded and may later be evicted. The suite is a stable baseline,
not a replacement for real room black-box testing.

## BC native Activity browser suite

`activity-blue.browser.js` verifies the real planner, the dynamic native
Activity catalog and execution-time permission revalidation. The suite only
uses `dryRunNativeActivity`; it never calls `ActivityRun`, sends a room message
or changes a character.

With a BC room open in the CDP browser:

```bash
node tests/run-activity-blue-cdp.mjs --repeats=3
```

The runner hot-loads the local candidate and checks that:

- an ordinary physical interaction prefers `intent=activity` without requiring
  the user to say “BC/official/native”;
- the target, Activity and body group are preserved;
- explicit pretend/action-description requests and chat remain outside the
  native Activity branch;
- a forged or stale candidate cannot bypass the current BC allowed catalog.

## Contextual sticker browser suite

`sticker-blue.browser.js` validates the four user-supplied production stickers,
their exact URLs and semantic selection boundaries. It also verifies that
ordinary chat, memory questions and native Activity requests do not select a
sticker.

```bash
node tests/run-sticker-blue-cdp.mjs --repeats=3
```

The runner temporarily enables the feature switch, hot-loads the local
candidate and restores the user's saved switch afterwards. Sending is dry-run
only: it never calls `ChatRoomSendChat` and never posts an image to the room.

## Friendship browser suite

`friend-blue.browser.js` verifies explicit self-requests, third-party consent
boundaries, ordinary friendship sentiment, weak/strong evidence classification
and native dry-run behavior:

```bash
node tests/run-friend-blue-cdp.mjs --repeats=3
```

The suite never calls the mutating add-friend path and asserts that
`Player.FriendList` remains unchanged.

## Multi-speaker context browser suite

`context-blue.browser.js` covers quoted first-person requests, singular
operation schemas, recent conversational answers, explicit corrections and
named Activity requests that drift into clarification:

```bash
node tests/run-context-blue-cdp.mjs --repeats=3
```

The suite only calls planning/debug hooks. It restores the page's recent
conversation context and never sends messages or mutates BC state.
When the planner API is unavailable, the deterministic JS guards can still be
verified without network calls:

```bash
node tests/run-context-blue-cdp.mjs --deterministic-only
```
