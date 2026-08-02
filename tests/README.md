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

The runner loads the local candidate in side-effect-free test mode and checks that:

- an ordinary physical interaction prefers `intent=activity` without requiring
  the user to say “BC/official/native”;
- the target, Activity and body group are preserved;
- explicit pretend/action-description requests and chat remain outside the
  native Activity branch;
- a forged or stale candidate cannot bypass the current BC allowed catalog.

Known v3.0.0 limitation: hair care requires `Hairbrush`, but the runtime does
not yet plan “equip Hairbrush, then run `TakeCare@ItemHead`” as a compound
Activity. The three hair-care cases remain explicit known failures when the
current catalog lacks `TakeCare`; `Pet@ItemHead` is not accepted as equivalent.

## Contextual sticker browser suite

`sticker-blue.browser.js` validates the four user-supplied production stickers,
their exact URLs and semantic selection boundaries. It also verifies that
ordinary chat, memory questions and native Activity requests do not select a
sticker.

```bash
node tests/run-sticker-blue-cdp.mjs --repeats=3
```

The runner temporarily enables the feature switch, loads the local candidate
in side-effect-free test mode and restores the user's saved switch afterwards.
Sending is dry-run only: it never calls `ChatRoomSendChat` and never posts an
image to the room.

Known v3.0.0 result: `tearful` can remain empty for the explicit sad/crying
positive case (0/3 in the release regression). The other three stickers,
catalog URLs and all no-sticker boundaries passed. Keep this case failing until
the behavior is fixed; it is a documented non-blocking release issue, not a
reason to weaken the expected result.

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
named Activity requests that drift into clarification. It also locks down the
rapid-call boundary that previously dropped the reply-model call after the
planner consumed the 30th shared local quota slot. The burst uses an immediate
mock response, so all 31 calls must reach the transport and return non-empty;
an empty thinking response must remain a single request rather than triggering
an automatic model retry:

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

## Structured reply protocol suite

`run-reply-protocol-cdp.mjs` loads the local candidate in side-effect-free test
mode and asks the real reply model for chat, action+speech, roleplay and one
typed command envelope. The chat cases include the two production empty-reply
reports and repeated invocation of the Misaka name.
It validates `misaka.reply.v1` parsing without calling `ChatRoomSendChat`,
`ActivityRun` or any character mutation path:

```bash
node tests/run-reply-protocol-cdp.mjs
```

## Planned item-operation browser suite

`run-item-operation-blue-cdp.mjs` drives the real planner and reply model for
natural device requests, then resolves every generated `itemadd` through the
same target-group resolver used by execution. It does not call the mutating
executor or send room messages.

The fixture currently requires Rin to be present and covers the colloquial,
Chinese asset-name and explicit BC asset-name forms of the pet-bed request:

```bash
node tests/run-item-operation-blue-cdp.mjs --repeats=3
```

It asserts that every request targets Rin, resolves to `PetBed`, survives the
plan boundary and maps semantic, native or omitted `part` values to the real
`ItemDevices` group.

## Fuzzy item semantics and mutation suite

`run-item-semantics-blue-cdp.mjs` builds cases from the live room roster,
Appearance state and BC asset catalog, then drives the real planner and reply
model without invoking any mutating executor. It covers:

- colloquial aliases, purpose descriptions and explicit Asset names;
- corrected, ambiguous and negated targets;
- semantic body parts and native BC groups;
- handheld, restraint and device additions;
- current-item removal, recoloring, property changes and device replacement.

Occupied or locked slots are not treated as valid add fixtures. Positive add
cases use a live character whose target group is free; mutation cases use a
currently worn, suitable item.

```bash
node tests/run-item-semantics-blue-cdp.mjs --repeats=2
```

Selected cases can be repeated independently:

```bash
node tests/run-item-semantics-blue-cdp.mjs \
  --repeats=3 \
  --ids=fuzzy-handheld-hairbrush,modify-current-vibrator-property
```

To repeat only selected cases while limiting model cost:

```bash
node tests/run-reply-protocol-cdp.mjs --ids=action-command-object
```

## Lifecycle and hot-reload suite

`run-lifecycle-blue-cdp.mjs` repeatedly loads the candidate in test mode and
asserts that every previous test lifecycle is disposed, no IndexedDB embedding
memory or runtime timer is created, and the active room runtime remains
untouched:

```bash
node tests/run-lifecycle-blue-cdp.mjs --iterations=10
```

The runner also forces garbage collection before and after the loop and fails
when retained heap growth exceeds 20 MiB. It does not send messages, install
socket hooks or mutate character state.
