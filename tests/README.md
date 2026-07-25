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

- an explicit request for a BC native action becomes `intent=activity`;
- the target, Activity and body group are preserved;
- roleplay and chat remain outside the native Activity branch;
- a forged or stale candidate cannot bypass the current BC allowed catalog.

## Contextual sticker suite (not created yet)

The production catalog is intentionally empty and the feature is disabled
until the user provides the official sticker IDs, URLs and semantic labels.
Create the contextual selection and sender regression only after that catalog
becomes the agreed source of truth; do not invent fixture IDs that look like
production data.

## Friendship browser suite

`friend-blue.browser.js` verifies explicit self-requests, third-party consent
boundaries, ordinary friendship sentiment, weak/strong evidence classification
and native dry-run behavior:

```bash
node tests/run-friend-blue-cdp.mjs --repeats=3
```

The suite never calls the mutating add-friend path and asserts that
`Player.FriendList` remains unchanged.
