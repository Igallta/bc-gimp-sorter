// MisakaChat v3.0.7 - BC 御坂自动回复系统
// 模块分区:
//   [Config]      L15-55   配置 + 状态
//   [Memory]      L56-440  IndexedDB / Embedding / 语义记忆 / Refine
//   [Idle]        L441-527 闲聊 / Heartbeat
//   [API]         L528-633 callLLM / Token 预算 / 响应诊断
//   [Persona]     L634-664 人设 + 房间名单缓存
//   [Actions]     L665-1459 指令解析 / 道具操作 / 移动 / ToolPolicy
//   [Chat]        L1460-1830 消息处理 / 噪音过滤 / handleReply / sanitize
//   [BCE]         L1582-1641 BCE 查询
//   [Commands]    L1831-1892 /misaka 命令系统
//   [Init]        L1893-end 初始化 / hook 安装

(function() {
  "use strict";

  const SCRIPT_VERSION = "3.0.7";
  const RELEASE_CHANNEL = "stable";
  const bootstrapOptions = window.__misakaNextBootstrapOptions || {};
  delete window.__misakaNextBootstrapOptions;
  const TEST_MODE = bootstrapOptions.mode === "test";
  window.__misakaScriptVersion = SCRIPT_VERSION;

  const lifecycleSlot = TEST_MODE ? "__misakaTestLifecycle" : "__misakaLifecycle";
  const previousLifecycle = window[lifecycleSlot];
  let previousHandoff = null;
  try { previousHandoff = previousLifecycle?.takeHandoff?.() || null; } catch (e) {}
  if (previousLifecycle?.dispose) previousLifecycle.dispose(TEST_MODE ? "test-reload" : "hot-reload");

  const lifecycle = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mode: TEST_MODE ? "test" : "runtime",
    disposed: false,
    timeouts: new Set(),
    intervals: new Set(),
    requests: new Set(),
    cleanups: new Set(),
    dispose(reason = "manual") {
      if (this.disposed) return;
      this.disposed = true;
      for (const timer of this.timeouts) clearTimeout(timer);
      for (const timer of this.intervals) clearInterval(timer);
      this.timeouts.clear();
      this.intervals.clear();
      for (const request of this.requests) {
        try { request.abort?.(); } catch (e) {}
      }
      this.requests.clear();
      for (const cleanup of this.cleanups) {
        try { cleanup(); } catch (e) {}
      }
      this.cleanups.clear();
      console.log(`[MisakaChat] 实例 ${this.id} 已销毁 (${reason})`);
    },
  };
  window[lifecycleSlot] = lifecycle;
  if (!TEST_MODE) {
    if (window.__misakaInstance) console.log("[MisakaChat] 杀掉旧实例 #" + window.__misakaInstance);
    window.__misakaInstance = lifecycle.id;
  }
  const myInstance = lifecycle.id;
  function isCurrent() {
    return !lifecycle.disposed && window[lifecycleSlot] === lifecycle &&
      (TEST_MODE || window.__misakaInstance === myInstance);
  }
  function onDispose(cleanup) {
    lifecycle.cleanups.add(cleanup);
    return cleanup;
  }
  function trackedTimeout(callback, delay) {
    const timer = setTimeout(() => {
      lifecycle.timeouts.delete(timer);
      if (isCurrent()) callback();
    }, delay);
    lifecycle.timeouts.add(timer);
    return timer;
  }
  function clearTrackedTimeout(timer) {
    clearTimeout(timer);
    lifecycle.timeouts.delete(timer);
  }
  function trackedInterval(callback, delay) {
    const timer = setInterval(() => {
      if (isCurrent()) callback();
    }, delay);
    lifecycle.intervals.add(timer);
    return timer;
  }
  function clearTrackedInterval(timer) {
    clearInterval(timer);
    lifecycle.intervals.delete(timer);
  }
  function trackRequest(request) {
    if (request) lifecycle.requests.add(request);
    return request;
  }
  function releaseRequest(request) {
    if (request) lifecycle.requests.delete(request);
  }

  const CONFIG = {
    enabled: true,
    apiBase: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    maxTokens: 8192,
    maxContext: 50,
    maxContextTokens: 20000, // context messages 的 token 预算上限(system prompt 不算)
    cooldownMs: 3000,
    perUserCooldownMs: 5000,
    apiKeyTimeout: 45000,
    // 一轮 action 最多包含规划、主回复、纠错、结果验收等多次 API 调用。
    // 45 秒会在工作仍进行时提前释放 busy，导致后续请求与旧请求并发串线。
    replyHardTimeoutMs: 180000,
    replyDelayMs: 800,
    clarificationTtlMs: 120000, // 同一发送者回答上一轮追问的承接窗口
    maxProfileEntries: 100, // 本地保留更多熟人，避免 20 人房间中反复“重新认识”
    maxPromptProfileEntries: 20, // 每轮只注入最相关的 20 人，控制提示词体积
    moveCooldownMs: 500,  // 移动操作冷却
    idleTimeoutMs: 600000,  // 10 分钟无人说话触发 idle
    idleCheckMs: 60000,  // 每分钟检查一次 idle
    embeddingProviders: [
      {
        name: "OpenAI",
        base: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-large",
        keyNames: ["misaka_openai_key"],
        dimensions: 3072,
      },
    ],
    maxMemoryEntries: 5000, // 约 30 天对话量
    memoryRefineInterval: 50,  // 每 N 条消息提炼一次长期记忆
    maxRefinedMemories: 20,  // 保留最近 N 条提炼记忆
    topKMemories: 3,  // 查询时返回最相似的 K 条记忆
    memoryRecallMinCosine: 0.48, // 原始语义相似度低于此值时宁可承认不记得
    memoryRecallExcludeRecentMs: 2 * 60 * 1000, // 近期消息由对话上下文负责，避免当前问题抢占长期召回
    memoryContextWindowMs: 5 * 60 * 1000, // 强命中前后只补取同一小段对话
    memoryContextNeighbors: 1, // 最高命中前后各补一条相邻记忆
    activityEnabled: true,
    activityCooldownMs: 15000,
    activityPerTargetCooldownMs: 60000,
    // 表情包只作为偶发的情绪补充；目录、冷却、重复冷却和每日上限共同
    // 防止刷屏。仍可用 /misaka sticker off 独立关闭。
    stickerEnabled: true,
    stickerCooldownMs: 2 * 60 * 1000,
    stickerRepeatCooldownMs: 30 * 60 * 1000,
    stickerDailyLimit: 12,
    // 自主修改真人关系属于高影响能力，首次发布默认关闭；通过
    // /misaka friend on 明确启用后才会评估或执行。
    autoFriendEnabled: false,
    autoFriendMinInteractions: 20,
    autoFriendMinDirectMessages: 5,
    autoFriendDailyLimit: 2,
    autoFriendCooldownMs: 6 * 60 * 60 * 1000,
    autoFriendReviewCooldownMs: 7 * 24 * 60 * 60 * 1000,
  };

  // 只允许模型选择固定 ID，绝不让模型生成网址。label 刻意写明适用边界，
  // 避免把玩闹式气鼓鼓用于严重冲突，或把恍然大悟误作长时间思考。
  // 附加表情仍可通过 misaka_sticker_catalog 注入，并通过相同 URL 校验。
  const BUILTIN_STICKER_CATALOG = Object.freeze([
    Object.freeze({
      id: "pout",
      url: "https://i.imgur.com/7WBMieG.png",
      label: "轻度生气、气鼓鼓地不服气（玩闹式不满，不用于严重冲突）",
      tags: Object.freeze(["生气", "气鼓鼓", "不满", "抱怨", "不服气", "被捉弄", "闹别扭"]),
    }),
    Object.freeze({
      id: "flustered_blush",
      url: "https://i.imgur.com/runjo00.png",
      label: "突然被戳中后惊慌脸红、害羞得不知所措",
      tags: Object.freeze(["脸红", "害羞", "惊讶", "惊慌", "被调戏", "不知所措", "措手不及"]),
    }),
    Object.freeze({
      id: "tearful",
      url: "https://i.imgur.com/09gQvFG.png",
      label: "受伤、委屈或难过到掉眼泪（不是喜极而泣）",
      tags: Object.freeze(["伤心", "哭哭", "委屈", "难过", "受伤", "掉眼泪", "想被安慰"]),
    }),
    Object.freeze({
      id: "sudden_realization",
      url: "https://i.imgur.com/OlJqOCD.png",
      label: "突然听懂、发现重点或恍然大悟（不是持续沉思）",
      tags: Object.freeze(["恍然大悟", "突然明白", "意外发现", "原来如此", "注意到", "灵光一现"]),
    }),
  ]);

  let state = {
    recentMessages: [],
    lastReplyTime: 0,
    lastUserReplyTime: {},
    messageCount: 0,
    busy: false,
    lastMoveTime: 0,  // 移动操作冷却
    lastActivityTime: 0,
    lastActivityByTarget: {},
    lastStickerTime: 0,
    lastStickerById: {},
    stickerDaily: { date: "", count: 0 },
    lastAutoFriendTime: 0,
    autoFriendDaily: { date: "", count: 0 },
    autoFriendInFlight: {},
    lastNonSelfMsgTime: 0,  // 上次非自己消息时间(idle 检测用)
    roomLog: [],          // 进出记录
    snapshots: {},        // 束缚快照 { memberNumber: { items, time } }
    pendingClarifications: {}, // 按发送者保存的待澄清请求；他人插话不会打断
  };
  onDispose(() => {
    state.semanticMemories = [];
    state.refinedMemories = [];
    state.recentMessages = [];
    state.roomLog = [];
    state.snapshots = {};
    state.pendingClarifications = {};
    if (!TEST_MODE && window.__misakaLifecycle === lifecycle) {
      window.__misakaOnMessage = null;
      window.__misakaGlobalBusy = false;
      window.__misakaReplyInProgress = false;
    }
  });
  lifecycle.takeHandoff = () => {
    if (lifecycle.disposed || TEST_MODE || !state.idbReady || !state.refinedIdbReady) return null;
    return {
      protocol: "misaka.lifecycle.v1",
      semanticMemories: state.semanticMemories,
      refinedMemories: state.refinedMemories,
    };
  };

  // 事务式替换期间只修改内存中的 Appearance，最后再统一同步一次。
  // 否则“删除旧道具”和“失败后恢复”会各自异步发包，服务器可能乱序处理。
  let deferredCharacterUpdates = null;
  function updateCharacter(char) {
    if (deferredCharacterUpdates) {
      deferredCharacterUpdates.set(Number(char?.MemberNumber), char);
      return;
    }
    ChatRoomCharacterUpdate(char);
  }

  window.__misakaDebugTrace = window.__misakaDebugTrace || [];
  function persistCapabilityTrace(entry) {
    if (!/^(activity|sticker|friend):/.test(String(entry?.stage || ""))) return;
    try {
      const clean = JSON.parse(JSON.stringify(entry, (key, value) => {
        if (["itemActivity", "embedding", "messages"].includes(key)) return undefined;
        if (typeof value === "string" && value.length > 500) return value.slice(0, 500);
        return value;
      }));
      const key = storageKey("capability_trace");
      const existing = JSON.parse(localStorage.getItem(key) || "[]");
      const records = Array.isArray(existing) ? existing : [];
      records.push(clean);
      while (records.length > 100) records.shift();
      localStorage.setItem(key, JSON.stringify(records));
    } catch (e) {}
  }

  function pushDebugTrace(entry) {
    try {
      const trace = window.__misakaDebugTrace;
      const record = {
        time: new Date().toISOString(),
        ...entry
      };
      trace.push(record);
      while (trace.length > 30) trace.shift();
      persistCapabilityTrace(record);
    } catch(e) {}
  }

  // 恢复 messageCount(避免刷新后归零导致 refine 不触发)
  try {
    const saved = parseInt(localStorage.getItem("misaka_msg_count") || "0", 10);
    if (saved > 0) state.messageCount = saved;
  } catch(e) {}

  // === [Memory] IndexedDB 封装 ===
  const IDB = (() => {
    const DB_NAME = "misaka_chat";
    const STORE_SEMANTIC = "semantic_mem";
    const STORE_REFINED = "refined_mem";
    let dbPromise = null;

    function openDB() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_SEMANTIC)) db.createObjectStore(STORE_SEMANTIC, { keyPath: "id", autoIncrement: true });
          if (!db.objectStoreNames.contains(STORE_REFINED)) db.createObjectStore(STORE_REFINED, { keyPath: "id", autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }

    async function transact(store, mode, fn) {
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(store, mode);
          fn(tx.objectStore(store));
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {
        console.warn("[MisakaChat] IDB transact 失败:", e.message);
        return false;
      }
    }

    async function getAll(store) {
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const req = db.transaction(store, "readonly").objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      } catch (e) {
        console.warn("[MisakaChat] IDB getAll 失败:", e.message);
        return [];
      }
    }

    return {
      getSemantic: () => getAll(STORE_SEMANTIC),
      getRefined: () => getAll(STORE_REFINED),
      putSemanticOne: (item) => transact(STORE_SEMANTIC, "readwrite", os => os.put(item)),
      putRefinedOne: (item) => transact(STORE_REFINED, "readwrite", os => os.put(item)),
      clearSemantic: () => transact(STORE_SEMANTIC, "readwrite", os => os.clear()),
      clearRefined: () => transact(STORE_REFINED, "readwrite", os => os.clear()),
      clearAll: () => Promise.all([
        transact(STORE_SEMANTIC, "readwrite", os => os.clear()),
        transact(STORE_REFINED, "readwrite", os => os.clear())
      ]),
      exportAll: async () => ({ semantic: await getAll(STORE_SEMANTIC), refined: await getAll(STORE_REFINED) }),
      importAll: async (data) => {
        if (data?.semantic) { await transact(STORE_SEMANTIC, "readwrite", os => os.clear()); await transact(STORE_SEMANTIC, "readwrite", os => data.semantic.forEach(i => os.put(i))); }
        if (data?.refined) { await transact(STORE_REFINED, "readwrite", os => os.clear()); await transact(STORE_REFINED, "readwrite", os => data.refined.forEach(i => os.put(i))); }
        return true;
      },
    };
  })();

  // 从 IndexedDB 异步加载语义记忆和提炼记忆(加载完成前用空数组占位)
  const handedOffMemory = !TEST_MODE &&
    previousHandoff?.protocol === "misaka.lifecycle.v1" &&
    Array.isArray(previousHandoff.semanticMemories) &&
    Array.isArray(previousHandoff.refinedMemories)
    ? previousHandoff
    : null;
  state.semanticMemories = handedOffMemory?.semanticMemories || [];
  state.refinedMemories = handedOffMemory?.refinedMemories || [];
  state.idbReady = false;
  state.refinedIdbReady = false;

  if (TEST_MODE) {
    state.idbReady = true;
    state.refinedIdbReady = true;
  } else if (handedOffMemory) {
    state.idbReady = true;
    state.refinedIdbReady = true;
    console.log(
      `[MisakaChat] 生命周期移交完成: ${state.semanticMemories.length} 条语义记忆, ` +
      `${state.refinedMemories.length} 条提炼记忆`
    );
  } else {
    IDB.getSemantic().then(entries => {
      if (!isCurrent()) return;
      if (Array.isArray(entries)) {
        // 按 time 排序(IndexedDB autoIncrement id 基本保序,但显式排序更稳)
        entries.sort((a, b) => (a.time || 0) - (b.time || 0));
        state.semanticMemories = entries;
      }
      state.idbReady = true;
      console.log(`[MisakaChat] IDB 加载完成: ${state.semanticMemories.length} 条语义记忆`);
    }).catch(e => {
      if (!isCurrent()) return;
      state.idbReady = true;
      console.warn("[MisakaChat] IDB 加载语义记忆失败,从空开始:", e.message);
    });

    IDB.getRefined().then(entries => {
      if (!isCurrent()) return;
      if (Array.isArray(entries)) {
        entries.sort((a, b) => (a.time || 0) - (b.time || 0));
        state.refinedMemories = entries;
      }
      state.refinedIdbReady = true;
      console.log(`[MisakaChat] IDB 加载完成: ${state.refinedMemories.length} 条提炼记忆`);
    }).catch(e => {
      if (!isCurrent()) return;
      state.refinedIdbReady = true;
      console.warn("[MisakaChat] IDB 加载提炼记忆失败:", e.message);
    });
  }




  function storageKey(prefix) { return "misaka_" + prefix; }

  function loadMemory() {
    try { return JSON.parse(localStorage.getItem(storageKey("memory")) || "{}"); }
    catch (e) { return { profiles: {} }; }
  }

  function saveMemory(mem) {
    try { localStorage.setItem(storageKey("memory"), JSON.stringify(mem)); }
    catch (e) { console.error("[MisakaChat] 保存记忆失败:", e.message); }
  }

  function profileRetentionScore(profile, now = Date.now()) {
    const lastChat = Date.parse(profile?.lastChat || "") || 0;
    const ageDays = lastChat ? Math.max(0, (now - lastChat) / 86400000) : 365;
    const recency = Math.max(0, 60 - ageDays);
    const frequency = Math.log2(1 + Math.max(0, Number(profile?.chatCount) || 0)) * 12;
    const hasNotes = profile?.notes && profile.notes !== "常客" ? 20 : 0;
    return recency + frequency + hasNotes;
  }

  function selectPromptProfiles(profiles, limit = CONFIG.maxPromptProfileEntries) {
    const entries = Object.entries(profiles || {});
    if (entries.length <= limit) return Object.fromEntries(entries);
    const roomMembers = new Set(
      (typeof ChatRoomCharacter !== "undefined" && Array.isArray(ChatRoomCharacter)
        ? ChatRoomCharacter : [])
        .map(c => String(c?.MemberNumber || ""))
        .filter(Boolean)
    );
    entries.sort((a, b) => {
      const aRoom = roomMembers.has(String(a[0])) ? 1 : 0;
      const bRoom = roomMembers.has(String(b[0])) ? 1 : 0;
      if (aRoom !== bRoom) return bRoom - aRoom;
      return profileRetentionScore(b[1]) - profileRetentionScore(a[1]);
    });
    return Object.fromEntries(entries.slice(0, limit));
  }

  function updateProfile(memberNumber, name, content) {
    const mem = loadMemory();
    if (!mem.profiles) mem.profiles = {};
    const existing = mem.profiles[memberNumber] || {
      name, firstSeen: new Date().toISOString().slice(0, 10),
      notes: "", chatCount: 0, lastChat: null
    };
    existing.name = name || existing.name;
    existing.chatCount = (existing.chatCount || 0) + 1;
    existing.lastChat = new Date().toISOString().slice(0, 16).replace("T", " ");
    if (!existing.notes) existing.notes = "常客";
    mem.profiles[memberNumber] = existing;
    const keys = Object.keys(mem.profiles);
    if (keys.length > CONFIG.maxProfileEntries) {
      keys.sort((a, b) => profileRetentionScore(mem.profiles[a]) - profileRetentionScore(mem.profiles[b]));
      for (const key of keys.slice(0, keys.length - CONFIG.maxProfileEntries)) delete mem.profiles[key];
    }
    saveMemory(mem);
  }

  // === [Memory] Embedding cache (LRU) ===
  const embeddingCache = new Map();
  const EMBEDDING_CACHE_MAX = 20;

  function readStoredSecret(keyName) {
    if (typeof window.__GM_getValue === "function") {
      try {
        const v = window.__GM_getValue(keyName);
        if (v) return { value: v, source: "GM:" + keyName };
      } catch(e) {}
    }
    try {
      const localValue = localStorage.getItem(keyName) || "";
      if (localValue) return { value: localValue, source: "localStorage:" + keyName };
    } catch(e) {}
    return { value: "", source: "missing:" + keyName };
  }

  // === [Memory] Semantic Memory (Embedding-based) ===
  // 语义库一直使用 OpenAI text-embedding-3-large 的 3,072 维向量。
  // 对话用的 misaka_apikey 不得作为 embedding key 回退。
  function getEmbeddingProviderStatus() {
    for (const provider of CONFIG.embeddingProviders) {
      for (const keyName of provider.keyNames || []) {
        const key = readStoredSecret(keyName);
        if (key.value) return { provider, key };
      }
    }
    return { provider: CONFIG.embeddingProviders[0], key: { value: "", source: "missing" } };
  }

  function buildEmbeddingBody(provider, text) {
    const body = { model: provider.model, input: text.slice(0, 2000) };
    if (provider.dimensions) body.dimensions = provider.dimensions;
    return JSON.stringify(body);
  }

  function requestEmbedding(provider, key, text) {
    const reqBody = buildEmbeddingBody(provider, text);
    const useGM = typeof window.__GM_xmlhttpRequest !== "undefined";
    return new Promise((resolve, reject) => {
      if (useGM) {
        window.__GM_xmlhttpRequest({
          method: "POST",
          url: provider.base,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key.value,
          },
          data: reqBody,
          timeout: 15000,
          onload: (resp) => {
            if (resp.status === 200) {
              try { resolve(JSON.parse(resp.responseText)); }
              catch(e) { reject(new Error(provider.name + " embedding parse error")); }
            } else {
              reject(new Error(provider.name + " embedding HTTP " + resp.status));
            }
          },
          onerror: () => reject(new Error(provider.name + " embedding network error")),
          ontimeout: () => reject(new Error(provider.name + " embedding timeout")),
        });
        return;
      }

      const xhr = new XMLHttpRequest();
      xhr.open("POST", provider.base, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Authorization", "Bearer " + key.value);
      xhr.timeout = 15000;
      xhr.ontimeout = () => reject(new Error(provider.name + " embedding timeout"));
      xhr.onerror = () => reject(new Error(provider.name + " embedding network error"));
      xhr.onload = () => {
        if (xhr.status === 200) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch(e) { reject(new Error(provider.name + " embedding parse error")); }
        } else {
          reject(new Error(provider.name + " embedding HTTP " + xhr.status));
        }
      };
      xhr.send(reqBody);
    });
  }

  async function getEmbedding(text) {
    const cacheKey = CONFIG.embeddingProviders.map(p => p.model).join("|") + "::" + text.slice(0, 200);
    if (embeddingCache.has(cacheKey)) {
      const cached = embeddingCache.get(cacheKey);
      embeddingCache.delete(cacheKey);
      embeddingCache.set(cacheKey, cached); // LRU: move to end
      return cached;
    }
    for (const provider of CONFIG.embeddingProviders) {
      for (const keyName of provider.keyNames || []) {
        const key = readStoredSecret(keyName);
        if (!key.value) continue;
        try {
          const resp = await requestEmbedding(provider, key, text);
          if (resp && resp.data && resp.data[0] && resp.data[0].embedding) {
            const result = resp.data[0].embedding;
            if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
              const firstKey = embeddingCache.keys().next().value;
              embeddingCache.delete(firstKey);
            }
            embeddingCache.set(cacheKey, result);
            return result;
          }
        } catch(e) {
          console.warn("[MisakaChat] " + provider.name + " 失败(" + key.source + "):", e.message);
        }
      }
    }
    return null;
  }

  function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom > 0 ? dot / denom : 0;
  }

  // 智能遗忘:超限时按价值评分淘汰低价值记忆,而非简单 FIFO
  function smartForget() {
    const now = Date.now();
    const scored = state.semanticMemories.map((m, i) => {
      const ageDays = (now - (m.time || 0)) / 86400000;
      const textLen = (m.text || "").length;
      // 价值 = 文本长度(信息量)× 时间衰减(越新价值越高)
      const value = textLen * Math.max(0.2, 1 - ageDays / 90);
      return { idx: i, value };
    });
    scored.sort((a, b) => a.value - b.value);
    // 淘汰价值最低的 10 条
    const toDrop = scored.slice(0, 10).map(s => s.idx).sort((a, b) => b - a);
    for (const idx of toDrop) {
      state.semanticMemories.splice(idx, 1);
    }
    // 全量同步 semantic store(超限淘汰是稀有事件,全量写可接受)
    IDB.clearSemantic().then(() => Promise.all(state.semanticMemories.map(m => IDB.putSemanticOne(m))));
    console.log(`[MisakaChat] 智能遗忘: 淘汰 ${toDrop.length} 条低价值记忆`);
  }

  // 存一条语义记忆(带 embedding)
  async function storeSemanticMemory(text, meta = {}) {
    if (!text || text.length < 15) return; // 太短的消息不值得存 embedding

    // 去重:搜索已有记忆,相似度 > 0.92 则跳过
    const dup = await searchMemories(text, 1);
    if (dup.length > 0 && dup[0].score > 0.92) return;

    if (state.semanticMemories.length >= CONFIG.maxMemoryEntries) {
      smartForget();
    }
    const emb = await getEmbedding(text);
    if (!emb) return;  // embedding 失败就不存
    const entry = {
      text: text.slice(0, 500),
      embedding: emb,
      time: Date.now(),
      ...meta,
    };
    state.semanticMemories.push(entry);
    IDB.putSemanticOne(entry); // 增量写入,不再全量覆盖
  }

  // 语义搜索:用 query embedding 找最相似的 K 条记忆(带时间衰减)
  async function searchMemories(query, topK = CONFIG.topKMemories) {
    if (!query || state.semanticMemories.length === 0) return [];
    const qEmb = await getEmbedding(query);
    if (!qEmb) return [];
    const now = Date.now();
    const scored = state.semanticMemories.map(m => {
      const cosine = cosineSim(qEmb, m.embedding);
      const ageDays = (now - (m.time || 0)) / 86400000;
      const decayed = cosine * Math.max(0.3, 1 - ageDays / 90); // 90天后最低保留30%权重
      return { text: m.text, time: m.time, score: decayed, ...m };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(s => s.score > 0.3);
  }

  function refinedContent(text) {
    return String(text || "")
      .replace(/^(?:\s*[-*•]\s*)+/, "")
      .replace(/^(?:\s*\[\d{1,2}[/-]\d{1,2}\]\s*)+/, "")
      .replace(/^(?:\s*[-*•]\s*)+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatRefinedMemory(raw, ts = Date.now(), maxLength = 100) {
    const date = new Date(ts).toLocaleDateString("zh-CN", {month:"2-digit", day:"2-digit"});
    const prefix = `[${date}] `;
    let content = refinedContent(raw);
    if (!content || /^(无|没有|none|n\/a)$/i.test(content)) return "";
    const maxContent = Math.max(1, maxLength - prefix.length);
    if (content.length > maxContent) {
      const window = content.slice(0, maxContent + 1);
      const boundary = Math.max(
        window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"),
        window.lastIndexOf("；"), window.lastIndexOf("."), window.lastIndexOf("!"),
        window.lastIndexOf("?"), window.lastIndexOf(";")
      );
      // 宁可丢弃一条过长且无法完整收尾的提炼，也不把残句当成长期事实。
      if (boundary < Math.floor(maxContent * 0.45)) return "";
      content = window.slice(0, boundary + 1).trim();
    }
    return prefix + content;
  }

  function isRefinementSourceMemory(memory) {
    const text = String(memory?.text || "");
    if (!text) return false;
    if (["Activity", "Action"].includes(memory?.messageType)) return false;
    return !/(?:VibeModeAction|Chat(?:Other|Self)-Item[A-Za-z]+-|OrgasmFailSurrender\d*|TriggerShock[12]|ActionActivateSafewordRelease)/i.test(text);
  }

  function parseRefinementResult(raw) {
    const text = String(raw || "").trim();
    if (!text || /^(无|没有|none|n\/a)$/i.test(text)) return null;
    const jsonText = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    try {
      const parsed = JSON.parse(jsonText);
      const category = String(parsed?.category || "").toLowerCase();
      const allowed = new Set(["relationship", "preference", "boundary", "identity", "ongoing_status"]);
      const memory = String(parsed?.memory || "").trim();
      if (!allowed.has(category) || !memory) return null;
      return { category, memory };
    } catch(e) {
      return null;
    }
  }

  async function findRefinedDuplicate(candidateText, candidateEmbedding) {
    const normalized = refinedContent(candidateText).toLowerCase();
    if (!normalized) return null;
    let best = null;
    for (const memory of state.refinedMemories || []) {
      const existing = refinedContent(memory?.text).toLowerCase();
      if (!existing) continue;
      let score = existing === normalized || existing.includes(normalized) || normalized.includes(existing) ? 1 : 0;
      if (candidateEmbedding && Array.isArray(memory?.embedding)) {
        score = Math.max(score, cosineSim(candidateEmbedding, memory.embedding));
      }
      if (!best || score > best.score) best = { memory, score };
    }
    return best && best.score >= 0.85 ? best : null;
  }

  function isSyntheticDialogueMemory(text) {
    return /\s→\s御坂\s*:/.test(String(text || ""));
  }

  function isHistoricalPromptMemory(text, memory) {
    const content = String(text || "").replace(/^[^:\n]{1,80}:\s*/, "");
    if (memory?.addressedToBot === true) return isExplicitPastQuestion(content);
    const addressesMisaka = /(?:misaka|御搬|御坂|搬运工)/i.test(content);
    return addressesMisaka && isExplicitPastQuestion(content);
  }

  async function searchLongTermMemories(query, topK = CONFIG.topKMemories) {
    const qEmb = await getEmbedding(query);
    if (!qEmb) return [];
    const now = Date.now();
    const results = [];

    // 语义原文负责还原具体对话；提炼记忆负责补充稳定事实。
    // 规划器通常会在概括记忆已足够时跳过检索，但这里仍同时覆盖两层，
    // 避免页面状态或提示词裁剪造成漏答。
    const sources = [
      { list: state.semanticMemories, source: "semantic" },
      { list: state.refinedMemories, source: "refined" },
    ];
    for (const { list, source } of sources) {
      if (!Array.isArray(list)) continue;
      for (let index = 0; index < list.length; index++) {
        const m = list[index];
        const text = typeof m === "string" ? m : m?.text;
        const emb = typeof m === "string" ? null : m?.embedding;
        if (!text) continue;
        if (source === "semantic") {
          // 旧版保存的“问题 → 御坂回复”是重复合成文本，不是聊天原文；
          // 当前问题与刚发生的对话则应由 recentMessages 负责，不能抢占旧事召回 Top K。
          if (isSyntheticDialogueMemory(text) || isHistoricalPromptMemory(text, m)) continue;
          const memoryTime = Number(m?.time) || 0;
          if (memoryTime > 0 && now - memoryTime < CONFIG.memoryRecallExcludeRecentMs) continue;
        }
        if (emb) {
          const cosine = cosineSim(qEmb, emb);
          // 原始 cosine 决定“是否相关”；时间只参与候选排序。
          // 这样老但准确的记忆不会被时间衰减误判为无关，新但牵强的片段也进不来。
          if (cosine < CONFIG.memoryRecallMinCosine) continue;
          const recency = Math.max(0.3, 1 - ((now - (m.time || 0)) / 86400000) / 90);
          const reliability = m.isSelf === true ? 0.9 : 1;
          results.push({
            text,
            time: Number(m.time) || 0,
            cosine,
            score: cosine * recency * reliability,
            source,
            index,
            sender: String(m.sender || ""),
            memberNum: Number(m.memberNum) || null,
            messageType: String(m.messageType || ""),
            isSelf: m.isSelf === true,
          });
        } else {
          // 关键词 fallback(无 embedding 的旧条目)
          const q = query.toLowerCase(), lower = text.toLowerCase();
          const terms = q.split(/[\s,,、。.!!??;;::]+/).filter(t => t.length >= 2);
          const matchedTerms = terms.filter(t => lower.includes(t)).length;
          const exact = q.length >= 2 && lower.includes(q);
          // 无向量旧条目只接受完整短语或至少两个关键词命中，避免单词碰巧相同。
          if (exact || matchedTerms >= Math.min(2, terms.length || 2)) {
            results.push({
              text,
              time: Number(m?.time) || 0,
              cosine: null,
              score: exact ? 3 : matchedTerms,
              source: source + "-keyword",
              index,
              sender: String(m?.sender || ""),
              memberNum: Number(m?.memberNum) || null,
              messageType: String(m?.messageType || ""),
              isSelf: m?.isSelf === true,
            });
          }
        }
      }
    }

    // 先排序再去重，重复文本保留更相关/更新的那条。
    const seen = new Set();
    const hits = results
      .sort((a, b) => b.score - a.score)
      .filter(r => r.text && !seen.has(r.text) && seen.add(r.text))
      .slice(0, topK);

    // 只围绕最高命中补取少量相邻对话，帮助还原上下文，又避免候选数量失控。
    const best = hits[0];
    if (best && best.source === "semantic" && Number.isInteger(best.index)) {
      const list = state.semanticMemories || [];
      const context = [];
      for (let offset = -CONFIG.memoryContextNeighbors; offset <= CONFIG.memoryContextNeighbors; offset++) {
        if (offset === 0) continue;
        const adjacent = list[best.index + offset];
        if (!adjacent?.text || adjacent.text === best.text) continue;
        if (isSyntheticDialogueMemory(adjacent.text) || isHistoricalPromptMemory(adjacent.text, adjacent)) continue;
        const adjacentTime = Number(adjacent.time) || 0;
        if (adjacentTime > 0 && Date.now() - adjacentTime < CONFIG.memoryRecallExcludeRecentMs) continue;
        const timeGap = Math.abs((Number(adjacent.time) || 0) - (Number(best.time) || 0));
        if (timeGap > CONFIG.memoryContextWindowMs) continue;
        context.push({
          text: adjacent.text,
          time: Number(adjacent.time) || 0,
          relation: offset < 0 ? "上文" : "下文",
        });
      }
      best.context = context;
    }

    return hits;
  }

  function formatMemoryCandidate(m, index) {
    const t = m.time
      ? new Date(m.time).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})
      : "时间未知";
    const confidence = Number.isFinite(m.cosine) ? `相似度 ${m.cosine.toFixed(2)}` : "关键词匹配";
    const speaker = m.sender
      ? `${m.sender}${m.memberNum ? `#${m.memberNum}` : ""}`
      : (m.source === "refined" ? "概括记忆" : "说话者未知");
    const type = m.messageType ? `｜${m.messageType}` : "";
    let line = `- 候选${index + 1} [${t}｜${confidence}｜${speaker}${type}] ${m.text}`;
    if (index === 0 && Array.isArray(m.context) && m.context.length > 0) {
      line += "\n" + m.context.map(c => {
        const ct = c.time
          ? new Date(c.time).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})
          : "时间未知";
        return `  - 相邻${c.relation} [${ct}] ${c.text}`;
      }).join("\n");
    }
    return line;
  }

  async function buildMemoryEvidence(query) {
    const hits = await searchLongTermMemories(query, CONFIG.topKMemories);
    if (hits.length === 0) return { query, hits, context: "" };
    const context = `【长期记忆候选片段】\n查询「${query}」\n` +
      "候选是真实保存的原文或概括事实，但彼此不一定属于同一事件。\n" +
      hits.map(formatMemoryCandidate).join("\n");
    return { query, hits, context };
  }

  function parseMemoryFinalAnswer(raw) {
    const jsonText = String(raw || "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    try {
      const parsed = JSON.parse(jsonText);
      const status = String(parsed?.status || "").toLowerCase();
      const answer = String(parsed?.answer || "").trim();
      if (!["supported", "conflict", "insufficient"].includes(status)) return null;
      if (!answer) return null;
      return { status, answer };
    } catch(e) {
      return null;
    }
  }

  function normalizeMemoryFinalReply(raw) {
    const cleaned = sanitizeReply(raw);
    if (!cleaned) return "";
    const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 2);
    if (lines.length === 1) {
      const mixed = lines[0].match(/^(\*[^*\n]+\*)\s*(\S[\s\S]*)$/);
      if (mixed) return `${mixed[1]}\n${mixed[2]}`;
    }
    return lines.join("\n");
  }

  function minimizeBinaryMemoryReply(reply, question, status) {
    if (status !== "supported" || !/(?:是不是|是否|有没有|有无|对不对|吗[？?]?\s*$)/.test(String(question || ""))) {
      return reply;
    }
    const lines = String(reply || "").split("\n");
    const index = lines.length - 1;
    const speech = lines[index].trim();
    const periodIndex = speech.search(/[。.]/);
    const firstSentence = periodIndex >= 0
      ? speech.slice(0, periodIndex + 1).trim()
      : speech;
    // 是非题只按首个句号收口。逗号和分号后的内容可能仍承载问题的核心谓词，
    // 例如“Rikka确实说过类似的话，想吃掉御坂”，不能再按分句截掉。
    if (firstSentence.length >= 6 && /[\p{L}\p{N}]/u.test(firstSentence)) {
      lines[index] = /[。.！？~～]$/.test(firstSentence) ? firstSentence : `${firstSentence}。`;
    }
    return lines.join("\n");
  }

  function buildPlannerMemoryQuery(plan, senderName, content) {
    const original = String(content || "").trim();
    const lower = original.toLowerCase();
    const sender = String(senderName || "").trim().toLowerCase();
    const botNames = new Set(["misaka", "御搬", "御坂", "搬运工"]);
    const entities = [...new Set((plan?.memoryEntities || [])
      .map(v => String(v || "").trim())
      .filter(Boolean))]
      .filter(entity => {
        const plain = entity.replace(/#\d+$/, "").trim();
        const normalized = plain.toLowerCase();
        // 规划器偶尔会把 MemberNumber 当作人物名返回。纯数字前缀会污染
        // embedding 查询，却不提供任何语义信息，应直接丢弃。
        if (!normalized || /^\d+$/.test(normalized) ||
            normalized === sender || botNames.has(normalized)) return false;
        return !lower.includes(normalized);
      })
      .slice(0, 4);
    return `${entities.length ? `${entities.join(" ")}｜` : ""}${original}`.slice(0, 500);
  }

  async function answerMemoryQuestion(plan, senderName, content) {
    const query = buildPlannerMemoryQuery(plan, senderName, content);
    const evidence = await buildMemoryEvidence(query);
    if (evidence.hits.length === 0) {
      return { reply: "唔……这件事我真的不记得了。", query, status: "insufficient", hitCount: 0 };
    }
    const system = `你是御坂的专用记忆回答器。当前回答者永远是御坂，不是咲、Baliny 或候选原文中的任何说话者。只根据真实候选回答用户问题，并保持御坂温柔、简短、略带傲娇的自然口吻。只输出 JSON：{"status":"supported|conflict|insufficient","answer":"最终回复"}。
规则：
1. 候选原文真实存在，但不同候选不保证属于同一事件。
2. 只能陈述候选直接支持的过去事实。禁止补充候选没有表达的语气、顺序、转折、次数、动机、原因或背景。
3. 问“为什么/原因”时，只有候选明确给出原因才能回答；否则 status=insufficient。
4. 允许多条原文共同支持的直接语义推断，但要用“看起来/应该”等措辞保留不确定性。
5. 用户问题不是证据。候选没有证明问题中的事件发生过时，status=insufficient。
6. 候选相互矛盾且没有明确的关系变化时，status=conflict，并自然说明前后说法不一致，建议询问本人。
7. 足以回答时 status=supported；无法回答核心问题时 status=insufficient。不要提“候选、证据、数据库、记录、相似度”等技术词。
8. 只要任一候选直接回答了用户所问的人物或事件，就应使用该事实，不要因为其他候选无关而判为 insufficient。
9. 没有原文明确支持时，不得补充“开玩笑”“凶巴巴”“改口”“后来原谅了”“看谁辛苦”等评价或后续；不得把陈述改写成提问、把推测改写成确认，或改变原话的说话方式。
10. answer 只回答用户所问的最小核心事实；用户只问“是不是/谁”时，不要顺带复述其他候选。answer 不超过50字，不输出 MEMSEARCH、操作指令或解释。若包含动作，第一行只能是 *动作*，第二行只能是台词。`;
    const user = `【用户问题】\n${senderName}: ${content}\n\n${evidence.context}`;
    const raw = await callLLM(system, [{ role: "user", content: user }], {
      thinking: false,
      temperature: 0,
      maxTokens: 256,
    });
    const result = parseMemoryFinalAnswer(raw);
    if (!result) {
      console.warn("[MisakaChat] 记忆回答器返回异常，改用保守兜底:", String(raw || "").slice(0, 120));
      return { reply: "唔……我记得不太清，不敢乱说。", query, status: "insufficient", hitCount: evidence.hits.length };
    }
    const parsed = parseActionCommands(result.answer);
    if (parsed.commands.length > 0 || result.status === "insufficient") {
      return { reply: "唔……我记得不太清，不敢乱说。", query, status: "insufficient", hitCount: evidence.hits.length };
    }
    const reply = minimizeBinaryMemoryReply(
      normalizeMemoryFinalReply(parsed.cleaned),
      content,
      result.status,
    );
    return {
      reply: reply || "唔……我记得不太清，不敢乱说。",
      query,
      status: reply ? result.status : "insufficient",
      hitCount: evidence.hits.length,
    };
  }





  // === [Memory] Long-term Memory Refinement ===
  // 每 memoryRefineInterval 条消息,用 LLM 从 profiles + semanticMemories 提炼长期记忆
  async function maybeRefineMemory() {
    if (state.messageCount % CONFIG.memoryRefineInterval !== 0) return;
    if (state.messageCount === 0) return;
    try {
      const mem = loadMemory();
      const profiles = Object.entries(selectPromptProfiles(mem.profiles || {})).map(([mn, info]) =>
        `#${mn} ${info.name}: ${info.notes || ""} (${info.chatCount || 0}次互动)`).join("\n");
      const recentSemantic = (state.semanticMemories || [])
        .slice(-80)
        .filter(isRefinementSourceMemory)
        .slice(-20)
        .map(m => m.text)
        .join("\n");

      const existingRefined = (state.refinedMemories || []).map(m => m.text).join("\n");

      const prompt = `从以下 BC 聊天记录中,只提炼【一条新的、跨多次对话仍有价值的稳定事实】。

只允许以下分类:
- relationship: 明确的人际关系或关系变化
- preference: 当事人明确说出的稳定偏好/厌恶
- boundary: 明确且持续适用的互动边界
- identity: 稳定身份、长期称呼或角色归属
- ongoing_status: 明确会持续一段时间的状态

严格输出 JSON，不要 markdown:
{"category":"relationship|preference|boundary|identity|ongoing_status","memory":"不超过100字的完整中文句子"}
没有符合条件的新事实则只回复"无"。

已有的概括记忆(不要重复这些内容,只提炼增量):
${existingRefined || "(空)"}

重要限制:
- 不要重复已有记忆里已经说过的信息。如果这批聊天记录里没有新信息,直接回复"无"。
- 不要把"让御坂改成某种颜色/操作某个颜色"当成用户偏好。
- 只有用户明确说"我喜欢/我最喜欢/我偏好/我讨厌"时,才能提炼为偏好。
- 御坂自我描述的外貌不一定准确,不要把御坂的自我介绍当作外貌事实。
- 不要推断原因和细节,只提炼明确说出的内容。
- 区分说话者:用户说的提炼为事实,御坂说的只提炼御坂自身偏好。
- 游戏动作、道具操作、临时玩笑、技术讨论、开发计划和测试对白都不是长期记忆。
- 一次性行为、普通聊天、影视观感、临时情绪、安装/导入/设置故障和未经本人确认的评价都不是长期记忆。
- 输出必须是一个语义完整的句子，不要加日期、项目符号或标题。

人物档案:
${profiles}

记忆片段:
${recentSemantic}`;
      const refined = await callLLM("你是严格的长期记忆提炼器。只输出指定 JSON 或‘无’，禁止把一次性事件、操作请求或技术问题保存为长期记忆。", [{role:"user", content: prompt}], {
        model: CONFIG.model,
      });
      const parsedRefinement = parseRefinementResult(refined);
      if (parsedRefinement) {
        const ts = Date.now();
        const refinedText = formatRefinedMemory(parsedRefinement.memory, ts, 100);
        if (!refinedText) {
          console.log("[MisakaChat] 提炼记忆格式不完整，跳过:", refined.slice(0, 60));
          return;
        }
        // 候选只与 refined_mem 比较，避免误接到原始 semantic_mem。
        let refinedEmb = null;
        try { refinedEmb = await getEmbedding(refinedContent(refinedText)); } catch(e) {}
        const refDup = await findRefinedDuplicate(refinedText, refinedEmb);
        if (refDup) {
          console.log("[MisakaChat] 提炼记忆去重跳过:", refined.slice(0, 40));
          return;
        }
        const entry = { text: refinedText, embedding: refinedEmb, time: ts };
        state.refinedMemories.push(entry);
        if (state.refinedMemories.length > CONFIG.maxRefinedMemories) {
          state.refinedMemories.shift();
        }
        // refined 最多 20 条,先 clear 再全量写,避免 autoIncrement 重复堆积
        await IDB.clearRefined();
        await Promise.all(state.refinedMemories.map(m => IDB.putRefinedOne(m)));
        console.log("[MisakaChat] 长期记忆提炼完成:", refined.slice(0, 50));
      } else if (refined && !/^(无|没有|none|n\/a)\s*$/i.test(refined.trim())) {
        console.log("[MisakaChat] 提炼结果不符合结构或分类，跳过:", refined.slice(0, 80));
      }
    } catch(e) {
      console.warn("[MisakaChat] 记忆提炼失败:", e.message);
    }
  }

  // === [Idle] Idle / Heartbeat ===
  let idleTimer = null;

  // BC 会把以 * 开头、又以 * 结尾的整条消息识别成 Action。模型偶尔会生成
  // “*动作*台词*”这种多一个尾星号的混合格式；sanitizeReply 清掉尾星号后仍会
  // 留下“*动作*台词”在同一行。这里把动作与台词强制拆开，交给 sendReply 分两条
  // 发送，确保台词不会被一起吞进 Action。
  function normalizeIdleReply(reply) {
    const cleaned = sanitizeReply(reply || "");
    if (!cleaned) return "";
    const normalized = [];
    for (let line of cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
      const leadingAction = line.match(/^\*([^*\n]+)\*(.*)$/);
      if (leadingAction) {
        normalized.push(`*${leadingAction[1].trim()}*`);
        const speech = leadingAction[2].replace(/^\*+|\*+$/g, "").trim();
        if (speech) normalized.push(speech);
      } else {
        // 不完整的星号不能留在行首，否则 BC 仍可能按 Action 解析整句。
        const starCount = (line.match(/\*/g) || []).length;
        if (starCount % 2 !== 0 || (line.startsWith("*") && !line.endsWith("*"))) {
          line = line.replace(/\*/g, "").trim();
        }
        if (line) normalized.push(line);
      }
      if (normalized.length >= 2) break;
    }
    return normalized.slice(0, 2).join("\n");
  }

  async function generateIdleLine() {
    try {
      // idle 去重:记录最近发过的 idle 内容
      if (!state.recentIdleLines) state.recentIdleLines = [];
      const recentIdle = state.recentIdleLines.slice(-3);
      // idle 不需要道具清单,用精简 prompt
      const systemPrompt = getSystemPrompt(false) +
        "\n\n【当前任务】房间安静了。自然地说一句闲聊或做一个小动作。不要分析或输出思考过程。" +
        `\n\n${structuredReplyInstruction()}`;
      // 扩大到最近 15 条,让 LLM 看到更完整的时间线
      const recent = state.recentMessages.slice(-15).map(m => {
        const t = new Date(m.time || Date.now());
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        if (m.isSelf) return `[${hh}:${mm}] 御坂: ${m.content}`;
        return `[${hh}:${mm}] ${m.senderName}#${m.senderMemberNumber || "?"}: ${m.content}`;
      }).join("\n");
      // 检测最近是否全是自己(深夜无人说话场景)
      const lastNonSelf = state.recentMessages.slice(-15).filter(m => !m.isSelf);
      const allSelf = lastNonSelf.length === 0 && state.recentMessages.length > 0;
      const idleHint = allSelf
        ? "\n(注意:最近没有任何玩家说话,房间非常安静。你可以做个无聊的小动作或者说一句自言自语。不要重复之前的动作。)"
        : "";
      const idleGuard = recentIdle.length
        ? `\n最近你已经说过:\n${recentIdle.join("\n")}\n不要重复类似内容。`
        : "";
      const userPrompt = `最近消息:\n${recent || "暂无消息"}${idleGuard}${idleHint}\n\n生成一句自然的闲聊（不超过40字），按最终回复协议输出。`;
      const reply = await callLLM(systemPrompt, [{ role: "user", content: userPrompt }], {
        model: CONFIG.model,
        json: true,
        // thinking 与最终回复共享输出预算；80 token 会偶发截断在半句话中。
        // 最终可见文本由结构化 action/speech 字段分别做 Unicode 安全限长。
        maxTokens: 1024,
      });
      const parsedReply = parseAssistantReply(reply || "", "chat");
      const cleaned = parsedReply.structured
        ? parsedReply.cleaned
        : normalizeIdleReply(reply || "");
      if (!cleaned || cleaned.length < 2) return "";
      // 简易去重:字符集相似度 > 0.7 跳过
      const similarity = (a, b) => {
        if (!a || !b) return 0;
        const setA = new Set(a.split(''));
        const setB = new Set(b.split(''));
        const intersect = [...setA].filter(c => setB.has(c)).length;
        return intersect / Math.max(setA.size, setB.size);
      };
      for (const prev of recentIdle) {
        if (similarity(cleaned, prev) > 0.7) {
          console.log("[MisakaChat] idle 去重: 与最近 idle 相似,跳过");
          return "";
        }
      }
      state.recentIdleLines.push(cleaned);
      if (state.recentIdleLines.length > 5) state.recentIdleLines.shift();
      return cleaned;
    } catch(e) {
      console.warn("[MisakaChat] idle LLM 生成失败:", e.message);
      return "";
    }
  }

  function startIdleTimer() {
    if (idleTimer) clearTrackedInterval(idleTimer);
    idleTimer = trackedInterval(async () => {
      if (!isCurrent() || !CONFIG.enabled || state.busy) return;
      if (typeof CurrentScreen === "undefined" || CurrentScreen !== "ChatRoom") return;
      const now = Date.now();
      if (state.lastNonSelfMsgTime && now - state.lastNonSelfMsgTime > CONFIG.idleTimeoutMs) {
        if (window.__misakaReplyInProgress || window.__misakaGlobalBusy) return;
        window.__misakaGlobalBusy = true;
        window.__misakaReplyInProgress = true;
        state.busy = true;
        try {
          const generated = await generateIdleLine();
          if (!isCurrent()) return;
          // fallback 也带变化,不要每次都同一条
          const fallbacks = [
            "*百无聊赖地翻看记录本*",
            "*无聊地玩弄手边的道具*",
            "*靠在墙边发呆*",
            "*无聊地数着天花板的纹路*",
            "*打了个哈欠,揉揉眼睛*",
            "*无聊地翻看房间里的束缚道具*",
            "*百无聊赖地望着房间发呆*",
            "*无聊地拨弄着头发*",
          ];
          // 避开最近用过的 fallback
          let line = generated;
          if (!line) {
            const recentSet = new Set((state.recentIdleLines || []).concat(state.recentFallbacks || []));
            const avail = fallbacks.filter(f => !recentSet.has(f));
            line = avail.length > 0 ? avail[Math.floor(Math.random() * avail.length)] : fallbacks[Math.floor(Math.random() * fallbacks.length)];
            if (!state.recentFallbacks) state.recentFallbacks = [];
            state.recentFallbacks.push(line);
            if (state.recentFallbacks.length > 4) state.recentFallbacks.shift();
          }
          state.lastNonSelfMsgTime = Date.now();  // 重置防再次触发
          if (typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom") {
            sendReply(line);
            state.recentMessages.push({ senderName: "御搬", content: line, isSelf: true, time: Date.now() });
            if (state.recentMessages.length > 50) state.recentMessages.shift();
          }
        } catch(e) { console.warn("[MisakaChat] idle 发送失败:", e.message); }
        finally {
          state.busy = false;
          if (isCurrent()) {
            window.__misakaGlobalBusy = false;
            window.__misakaReplyInProgress = false;
          }
        }
      }
    }, CONFIG.idleCheckMs);
  }

  // 有人进入时打招呼(延迟 2-5 秒,不抢话)

// 从 DeepSeek 响应提取回复(处理 thinking 模式 content 为空)
  function extractReply(msg) {
    if (!msg) return null;
    // thinking 模式下:reasoning_content 是思考过程,content 是最终回复
    // 只取 content,永不回退到 reasoning_content
    return (msg.content || "").trim() || null;
  }

  // === [API] callLLM ===

  // 粗估 token 数:中文≈2 token/字,英文≈1.3 token/字,符号≈1 token/字
  function estimateTokens(text) {
    if (!text) return 0;
    let tokens = 0;
    for (const ch of text) {
      if (/[[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) tokens += 2;
      else if (/[a-zA-Z0-9]/.test(ch)) tokens += 1.3;
      else tokens += 1;
    }
    return Math.ceil(tokens);
  }

  // 按 token 预算截断 context messages(从末尾保留最近的)
  function trimContextByTokenBudget(messages, budget) {
    if (!messages || messages.length === 0) return messages;
    let total = 0;
    let cutIdx = 0; // 不 break 时保留全部
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = estimateTokens(messages[i].content || "");
      if (total + t > budget) { cutIdx = i + 1; break; }
      total += t;
    }
    return messages.slice(Math.max(0, cutIdx));
  }

  function getApiKeyStatus() {
    let gmValue = "";
    if (typeof window.__GM_getValue === "function") {
      try { gmValue = window.__GM_getValue("misaka_apikey") || ""; } catch(e) {}
    }
    const localValue = localStorage.getItem(storageKey("apikey")) || "";
    return {
      value: gmValue || localValue,
      source: gmValue ? "GM" : (localValue ? "localStorage" : "missing"),
      hasGM: !!gmValue,
      hasLocal: !!localValue,
    };
  }

  async function callLLM(systemPrompt, contextMessages, options = {}) {
    if (!isCurrent()) return null;
    const apiKey = getApiKeyStatus().value;
    if (!apiKey) { console.warn("[MisakaChat] 未设置 API key"); return null; }
    const messages = [{ role: "system", content: systemPrompt }, ...contextMessages];
    const primaryModel = options.model || CONFIG.model;
    const maxTokens = options.maxTokens || CONFIG.maxTokens;

    const useThinking = options.thinking !== false;
    return new Promise((resolve) => {
      let settled = false;
      let disposeResolver = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (disposeResolver) lifecycle.cleanups.delete(disposeResolver);
        resolve(value);
      };
      disposeResolver = onDispose(() => finish(null));
      const handleResponse = (status, responseText, model) => {
        try {
          const data = JSON.parse(responseText);
          const choice = data.choices?.[0];
          const reply = extractReply(choice?.message);
          if (reply) {
            finish(reply);
            return;
          }
          console.warn("[MisakaChat] LLM 响应无最终内容", {
            status: Number(status || 0),
            model,
            finishReason: choice?.finish_reason || "",
            reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens || 0,
            completionTokens: data.usage?.completion_tokens || 0,
            errorCode: data.error?.code || "",
          });
        } catch (error) {
          console.warn("[MisakaChat] LLM 响应解析失败:", error.message);
        }
        finish(null);
      };
      const doRequest = (url, model) => {
        if (!isCurrent()) { finish(null); return; }
        // thinking 模式:思考进 reasoning_content,回复进 content
        const bodyObj = { model, messages, max_tokens: maxTokens };
        if (Number.isFinite(options.temperature)) bodyObj.temperature = options.temperature;
        if (options.json === true) bodyObj.response_format = { type: "json_object" };
        bodyObj.thinking = { type: useThinking ? "enabled" : "disabled" };
        const reqBody = JSON.stringify(bodyObj);
        const useGM = typeof window.__GM_xmlhttpRequest !== "undefined";

        if (useGM) {
          let request = null;
          const complete = (callback) => (...args) => {
            releaseRequest(request);
            if (!isCurrent()) { finish(null); return; }
            callback(...args);
          };
          request = trackRequest(window.__GM_xmlhttpRequest({
            method: "POST", url, headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + apiKey
            }, data: reqBody, timeout: CONFIG.apiKeyTimeout,
            onload: complete(resp => handleResponse(resp.status, resp.responseText, model)),
            onerror: complete(() => { console.warn("[MisakaChat] LLM 网络请求失败"); finish(null); }),
            ontimeout: complete(() => { console.warn("[MisakaChat] LLM 请求超时"); finish(null); })
          }));
        } else {
          const xhr = new XMLHttpRequest();
          trackRequest(xhr);
          const complete = (callback) => (...args) => {
            releaseRequest(xhr);
            if (!isCurrent()) { finish(null); return; }
            callback(...args);
          };
          xhr.open("POST", url, true);
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.setRequestHeader("Authorization", "Bearer " + apiKey);
          xhr.timeout = CONFIG.apiKeyTimeout;
          xhr.onload = complete(() => handleResponse(xhr.status, xhr.responseText, model));
          xhr.onerror = complete(() => { console.warn("[MisakaChat] LLM 网络请求失败"); finish(null); });
          xhr.ontimeout = complete(() => { console.warn("[MisakaChat] LLM 请求超时"); finish(null); });
          xhr.onabort = complete(() => finish(null));
          xhr.send(reqBody);
        }
      };
      doRequest(CONFIG.apiBase, primaryModel);
    });
  }

  // === [Persona] 人设 + 房间名单缓存 ===
  let _rosterCache = { snapshot: "", roster: "", time: 0 };
  let _itemCatalogCache = { text: "", time: 0 };
  let _plannerDeviceCatalogCache = { text: "", time: 0 };
  let _plannerHandheldCatalogCache = { text: "", time: 0 };

  // 道具清单按需注入:只在涉及道具/穿着/操作时才加载完整清单
  function getItemCatalog() {
    if (typeof MisakaPersona === "undefined") return "";
    const now = Date.now();
    // 缓存 5 分钟,避免每次道具相关对话都重建
    if (_itemCatalogCache.text && now - _itemCatalogCache.time < 300000) return _itemCatalogCache.text;
    const text = MisakaPersona.buildItemCatalog();
    _itemCatalogCache = { text, time: now };
    return text;
  }

  // 规划器不需要完整道具清单，但必须知道 ItemDevices 中有哪些真实设备。
  // 否则它只看见人物当前穿着时，容易把 PetBed、Cage、Kennel 等不同设备
  // 混成同一个概念，再错误地用房间 MOVE 冒充“进入设备”。
  function getPlannerDeviceCatalog() {
    const now = Date.now();
    if (_plannerDeviceCatalogCache.text && now - _plannerDeviceCatalogCache.time < 300000) {
      return _plannerDeviceCatalogCache.text;
    }
    try {
      const group = (typeof AssetGroup !== "undefined" && Array.isArray(AssetGroup))
        ? AssetGroup.find(g => g?.Name === "ItemDevices")
        : null;
      const assets = Array.isArray(group?.Asset)
        ? group.Asset
        : ((typeof Asset !== "undefined" && Array.isArray(Asset))
          ? Asset.filter(a => a?.Group?.Name === "ItemDevices")
          : []);
      const text = assets.map(a => {
        const archetype = a?.Archetype ? `/${a.Archetype}` : "";
        return `${a?.Name || "?"}=${a?.Description || a?.Name || "?"}${archetype}`;
      }).filter(Boolean).join("；").slice(0, 9000);
      _plannerDeviceCatalogCache = { text, time: now };
      return text;
    } catch (e) {
      console.warn("[MisakaChat] 构建规划器设备目录失败:", e.message);
      return "";
    }
  }

  // “给点吃的”“也要一份”之类请求需要规划器先知道真实手持物目录，
  // 否则它只能凭中文表述猜 Asset，或者在已有明确语境时反复追问。
  function getPlannerHandheldCatalog() {
    const now = Date.now();
    if (_plannerHandheldCatalogCache.text && now - _plannerHandheldCatalogCache.time < 300000) {
      return _plannerHandheldCatalogCache.text;
    }
    try {
      const assets = (typeof Asset !== "undefined" && Array.isArray(Asset))
        ? Asset.filter(a => a?.Group?.Name === "ItemHandheld")
        : [];
      const text = assets.map(a => {
        const cn = typeof MisakaPersona !== "undefined" && typeof MisakaPersona.assetCnName === "function"
          ? MisakaPersona.assetCnName(a)
          : "";
        const names = [...new Set([a?.Description, cn].filter(Boolean))];
        const propertyHints = typeof MisakaPersona !== "undefined" && typeof MisakaPersona.getPropertyHints === "function"
          ? MisakaPersona.getPropertyHints(a)
          : [];
        const hints = propertyHints.length > 0 ? ` [${propertyHints.join("；")}]` : "";
        return `${a?.Name || "?"}=${names.join("/") || a?.Name || "?"}${hints}`;
      }).filter(Boolean).join("；").slice(0, 9000);
      _plannerHandheldCatalogCache = { text, time: now };
      return text;
    } catch (e) {
      console.warn("[MisakaChat] 构建规划器手持物目录失败:", e.message);
      return "";
    }
  }

  function buildPlannerRecentContext(limit = 10) {
    return state.recentMessages.slice(-limit).map(m => {
      const t = new Date(m.time || Date.now());
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      const who = m.isSelf ? "御坂" : `${m.senderName}#${m.senderMemberNumber || "?"}`;
      const content = String(m.content || "").slice(0, 220);
      const correction = !m.isSelf && /^(?:不对|不是|错了|更正|准确地?说|应该是|其实是)[，,：:\s]/.test(content.trim())
        ? "【显式纠正：此句覆盖同话题的较早说法】"
        : "";
      return `[${hh}:${mm}] ${who}: ${correction}${content}`;
    }).join("\n").slice(-5000);
  }

  function normalizePlannerOperations(rawOperations, roomNumbers, validTypes, validParts) {
    return (Array.isArray(rawOperations) ? rawOperations : []).map(op => ({
      types: (Array.isArray(op?.types) ? op.types : [op?.type]).filter(t => validTypes.has(t)),
      targets: (Array.isArray(op?.targets) ? op.targets : []).map(Number).filter(n => roomNumbers.has(n)),
      parts: (Array.isArray(op?.parts) ? op.parts : []).filter(p => validParts.has(p)),
      assets: (Array.isArray(op?.assets) ? op.assets : [])
        .map(name => String(name || "").trim())
        .filter(name => /^[A-Za-z0-9_]+$/.test(name))
        .slice(0, 8),
    })).filter(op => op.types.length > 0 && op.targets.length > 0);
  }

  function enrichPlannerAssetsFromExplicitMentions(plan, content) {
    if (plan?.intent !== "action" || plan?.constraints?.replaceExisting ||
        plan?.constraints?.noStack || typeof Asset === "undefined" ||
        !Array.isArray(Asset)) return plan;
    const source = stripQuotedSegments(content);
    const sourceLower = source.toLowerCase();
    const itemTypes = new Set(["itemadd", "itemdel", "itemset", "itemcolor"]);
    for (const operation of plan.operations || []) {
      if (operation.assets?.length || !operation.types?.some(type => itemTypes.has(type))) continue;
      const allowedGroups = (operation.parts || []).flatMap(part => BODY_PART_GROUPS[part] || []);
      const target = actionTargetCharacter(Number(operation.targets?.[0]));
      const candidates = Asset.filter(asset => {
        const group = asset?.Group?.Name || "";
        if (!group.startsWith("Item")) return false;
        if (allowedGroups.length > 0 && !allowedGroups.includes(group)) return false;
        if (target && !AssetGet(target.AssetFamily, group, asset.Name)) return false;
        const names = [
          String(asset.Name || "").trim(),
          String(asset.Description || "").trim(),
          String(assetCnName(asset) || "").trim(),
        ].filter(name => name.length >= 2);
        return names.some(name => /^[\x00-\x7F]+$/.test(name)
          ? sourceLower.includes(name.toLowerCase())
          : source.includes(name));
      });
      const uniqueAssets = [...new Set(candidates.map(asset => asset.Name))];
      if (uniqueAssets.length === 1) operation.assets = uniqueAssets;
    }
    return plan;
  }

  function stripQuotedSegments(content) {
    let text = String(content || "");
    const pairedQuotes = [
      /“[^”]*”/g, /‘[^’]*’/g, /「[^」]*」/g, /『[^』]*』/g,
      /"[^"]*"/g, /'[^']*'/g,
    ];
    for (const pattern of pairedQuotes) text = text.replace(pattern, " ");
    return text.replace(/\s+/g, " ").trim();
  }

  const IDENTITY_VARIANT_FOLD = Object.freeze({
    "殘": "残",
    "楓": "枫",
  });

  function foldIdentityText(value) {
    return String(value || "").normalize("NFKC").toLowerCase()
      .replace(/[殘楓]/g, character => IDENTITY_VARIANT_FOLD[character] || character)
      .replace(/\s+/g, " ").trim();
  }

  function identityTextContains(content, alias) {
    const text = foldIdentityText(content);
    const name = foldIdentityText(alias);
    if (!name) return false;
    if (/^[\x00-\x7F]+$/.test(name)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, "i").test(text);
    }
    return text.includes(name);
  }

  function beginsWithMisakaInvocation(content) {
    const text = foldIdentityText(content);
    const aliases = [...new Set([
      "御坂", "御搬", "Misaka", Player?.Nickname, Player?.Name,
    ].map(foldIdentityText).filter(Boolean))];
    return aliases.some(alias => text === alias ||
      text.startsWith(`${alias}，`) || text.startsWith(`${alias},`) ||
      text.startsWith(`${alias}：`) || text.startsWith(`${alias}:`) ||
      text.startsWith(`${alias} `));
  }

  function discardInvocationSelfMatch(matches, content) {
    const playerNumber = Number(Player?.MemberNumber);
    if (matches.size > 1 && Number.isFinite(playerNumber) &&
        matches.has(playerNumber) && beginsWithMisakaInvocation(content)) {
      matches.delete(playerNumber);
    }
    return matches;
  }

  function hasPairedQuotedSegment(content) {
    return /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/.test(
      String(content || ""),
    );
  }

  function normalizePlannerQuotedReportDecision(plan, content) {
    if (!plan || !hasPairedQuotedSegment(content)) return plan;
    const outside = stripQuotedSegments(content);
    const reportsSpeech = /(?:说|表示|提到|引用|原话|转述)/.test(outside);
    const asksPerception = /(?:听到|听见|看见|看到|注意到|记得).*(?:吗|没|没有|是否|么)|(?:吗|没|没有|是否|么).*(?:听到|听见|看见|看到|注意到|记得)/.test(outside);
    if (!reportsSpeech || !asksPerception) return plan;
    plan.intent = "chat";
    plan.memorySearch = false;
    plan.memoryEntities = [];
    plan.stickerId = "";
    plan.needsCatalog = false;
    plan.operations = [];
    plan.goal = "";
    plan.activity = { target: null, request: "" };
    plan.question = "";
    plan.quotedReportOnly = true;
    return plan;
  }

  function normalizePlannerAmbiguousSingleItemDecision(plan, content) {
    if (plan?.intent !== "action" || !Array.isArray(plan.operations)) return plan;
    const text = stripQuotedSegments(content);
    if (!/(?:那个|这个|那件|这件)(?:玩具|东西|道具|设备)/.test(text) ||
        /(?:全部|所有|都|一起|每个|每件)/.test(text)) return plan;
    const mutations = plan.operations.filter(operation =>
      (operation?.types || []).some(type =>
        ["itemdel", "itemset", "itemcolor"].includes(type)));
    if (mutations.length === 0) return plan;
    const assets = [...new Set(mutations.flatMap(operation => operation.assets || []))];
    if (assets.length === 1) return plan;
    plan.intent = "clarify";
    plan.memorySearch = false;
    plan.memoryEntities = [];
    plan.stickerId = "";
    plan.needsCatalog = false;
    plan.operations = [];
    plan.question = "你说的是哪一个玩具？";
    return plan;
  }

  function normalizePlannerSimpleRoleplayDecision(plan, content) {
    if (!plan) return plan;
    const text = stripQuotedSegments(content);
    if (!/(?:朝|对着)?我.{0,4}眨(?:一?下|眨)?眼/.test(text)) return plan;
    plan.intent = "roleplay";
    plan.memorySearch = false;
    plan.memoryEntities = [];
    plan.stickerId = "";
    plan.needsCatalog = false;
    plan.operations = [];
    plan.question = "";
    plan.simpleRoleplay = "wink";
    return plan;
  }

  function normalizePlannerExplicitActionTargets(plan, content) {
    if (plan?.intent !== "action" || !Array.isArray(plan.operations) ||
        !Array.isArray(ChatRoomCharacter)) return plan;
    const text = stripQuotedSegments(content);
    const matched = new Map();
    for (const character of ChatRoomCharacter) {
      const displayName = String(character?.Nickname || character?.Name || "").trim();
      if (displayName.length < 2 && !/[^\x00-\x7F]/.test(displayName)) continue;
      if (identityTextContains(text, displayName)) {
        matched.set(Number(character.MemberNumber), character);
      }
    }
    discardInvocationSelfMatch(matched, text);
    // 账号名可能与另一位玩家的当前显示名重复。用户直接写出唯一显示名时，
    // 显示名优先；若同时明确提到多个人，则保留规划器对主客体的判断。
    if (matched.size !== 1) return plan;
    const explicitTarget = [...matched.keys()][0];
    for (const operation of plan.operations) {
      if (Array.isArray(operation.targets) && operation.targets.length > 0) {
        operation.targets = [explicitTarget];
      }
    }
    return plan;
  }

  function findUniqueMentionedRoomCharacter(content) {
    if (!Array.isArray(ChatRoomCharacter)) return null;
    const text = stripQuotedSegments(content);
    const matches = new Map();
    for (const character of ChatRoomCharacter) {
      const memberNumber = Number(character?.MemberNumber);
      if (!Number.isFinite(memberNumber)) continue;
      const aliases = [...new Set([
        character?.Nickname,
        character?.Name,
        `#${memberNumber}`,
      ].map(value => String(value || "").trim()).filter(value =>
        value.length >= 2 || /[^\x00-\x7F]/.test(value)))];
      if (aliases.some(alias => identityTextContains(text, alias))) {
        matches.set(memberNumber, character);
      }
    }
    discardInvocationSelfMatch(matches, text);
    return matches.size === 1 ? [...matches.values()][0] : null;
  }

  function findExplicitHandheldAsset(content, target) {
    if (!target || typeof Asset === "undefined" || !Array.isArray(Asset) ||
        typeof AssetGet !== "function") return null;
    const text = foldIdentityText(content);
    const candidates = Asset.filter(asset => {
      if (asset?.Group?.Name !== "ItemHandheld" ||
          !AssetGet(target.AssetFamily, "ItemHandheld", asset.Name)) return false;
      const aliases = [...new Set([
        asset.Name,
        asset.Description,
        assetCnName(asset),
      ].map(value => String(value || "").trim()).filter(value => value.length >= 2))];
      return aliases.some(alias => text.includes(foldIdentityText(alias)));
    });
    const names = [...new Set(candidates.map(asset => asset.Name))];
    return names.length === 1 ? names[0] : null;
  }

  function findPreferredHandheldFoodAsset(target, excludedAsset = "") {
    if (!target || typeof AssetGet !== "function") return null;
    const excluded = String(excludedAsset || "");
    const preferred = ["棒棒糖", "烤鱼", "蛋糕卷", "鸡腿", "糖果手杖"];
    return preferred.find(name => name !== excluded &&
      !!AssetGet(target.AssetFamily, "ItemHandheld", name)) || null;
  }

  // “给某人一个/一份 X”在御坂协议中表示把真实 ItemHandheld 放到目标手里。
  // 这一语义可由当前房间名单和 Asset 目录完全确定，不应让规划器在御坂本人、
  // ItemMouth 与纯文字 roleplay 之间漂移。
  function normalizePlannerHandheldGiveDecision(plan, content, senderNum) {
    if (!plan || !Array.isArray(ChatRoomCharacter)) return plan;
    const text = stripQuotedSegments(content);
    if (!/(?:给|給|递给|遞給|交给|交給|放到|放在|塞到|塞進|塞进)/.test(text) ||
        /(?:不要|別|别|不用|无需|無需|不必).{0,12}(?:给|給|递|遞|放|塞)/.test(text) ||
        /(?:喂|餵|吃一口|尝一口|嘗一口|递到嘴边|遞到嘴邊|放到嘴里|放到嘴裡|含住|舔)/.test(text)) {
      return plan;
    }
    let target = findUniqueMentionedRoomCharacter(text);
    const givesToSender = /(?:给|給|递给|遞給|交给|交給).{0,5}我(?:一|个|個|份|根|点|點|些|$)|(?:我的手|我手里|我手裡)/.test(text);
    if (givesToSender) {
      target = ChatRoomCharacter.find(character =>
        Number(character?.MemberNumber) === Number(senderNum)) || target;
    }
    if (!target) return plan;
    const explicitAsset = findExplicitHandheldAsset(text, target);
    const genericFood = /(?:点|點|份|些|个|個|根).{0,4}(?:吃的|食物|零食)|(?:吃的|食物|零食).{0,4}(?:给|給)/.test(text);
    if (!explicitAsset && !genericFood) return plan;
    const selectedAsset = explicitAsset || findPreferredHandheldFoodAsset(target);
    if (!selectedAsset) return plan;

    plan.intent = "action";
    plan.failed = false;
    plan.memorySearch = false;
    plan.memoryEntities = [];
    plan.stickerId = "";
    plan.needsCatalog = true;
    plan.operations = [{
      types: ["itemadd", "itemset"],
      targets: [Number(target.MemberNumber)],
      parts: ["ItemHandheld"],
      assets: [selectedAsset],
    }];
    plan.goal = `把${selectedAsset}放到${target.Nickname || target.Name}手里`;
    plan.question = "";
    return plan;
  }

  function normalizePlannerExpiredHandheldReplacement(plan, content) {
    if (!plan || !Array.isArray(ChatRoomCharacter)) return plan;
    const text = stripQuotedSegments(content);
    if (!/(?:过期|過期|坏了|壞了|不新鲜|不新鮮)/.test(text) ||
        !/(?:换个别的|換個別的|换一个|換一個|换根新的|換根新的)/.test(text)) {
      return plan;
    }
    let target = findUniqueMentionedRoomCharacter(text);
    if (/(?:你手里|你手裡|你拿着|你拿著)/.test(text)) target = Player;
    if (!target) return plan;
    const worn = (target.Appearance || []).filter(item => {
      if (item?.Asset?.Group?.Name !== "ItemHandheld") return false;
      const aliases = [item.Asset.Name, item.Asset.Description, assetCnName(item.Asset)];
      return aliases.some(alias => alias && foldIdentityText(text).includes(foldIdentityText(alias)));
    });
    if (worn.length !== 1) return plan;
    const oldAsset = worn[0].Asset.Name;
    const newAsset = findPreferredHandheldFoodAsset(target, oldAsset);
    if (!newAsset) return plan;

    plan.intent = "action";
    plan.failed = false;
    plan.memorySearch = false;
    plan.memoryEntities = [];
    plan.stickerId = "";
    plan.needsCatalog = true;
    plan.operations = [{
      types: ["itemdel"],
      targets: [Number(target.MemberNumber)],
      parts: ["ItemHandheld"],
      assets: [oldAsset],
    }, {
      types: ["itemadd", "itemset"],
      targets: [Number(target.MemberNumber)],
      parts: ["ItemHandheld"],
      assets: [newAsset],
    }];
    plan.constraints = {
      ...(plan.constraints || {}),
      noMove: true,
      noAdd: false,
      replaceExisting: true,
      noStack: true,
      preserveParts: [],
    };
    plan.goal = `把${target.Nickname || target.Name}手里的${oldAsset}换成${newAsset}`;
    plan.question = "";
    return plan;
  }

  function normalizePlannerExplicitItemAddDecision(plan, content) {
    if (!plan || !["action", "clarify"].includes(plan.intent)) return plan;
    const hasPlannedItemOperation = (plan.operations || []).some(operation =>
      (operation.types || []).some(type =>
        ["itemadd", "itemdel", "itemset", "itemcolor"].includes(type)));
    if (plan.intent === "action" && hasPlannedItemOperation) return plan;
    const text = stripQuotedSegments(content);
    if (!text || /(?:不要|别|不许|不准|先别|别真的|无需|不用).{0,16}(?:装|戴|塞|绑|放|递|给)/.test(text)) {
      return plan;
    }
    if (/(?:取下|摘下|脱掉|去掉|移除|拿掉|卸下|改成|改为|换成|设成|设为|调到|调成|调为|颜色|强度|档位|模式|样式)/.test(text)) {
      return plan;
    }
    const target = findUniqueMentionedRoomCharacter(text);
    if (!target) return plan;
    const requestsAdd = /(?:给|替|帮|把|用|递给|放到|塞上|戴上|戴个|装备|安装|安排|发个|拿个)/.test(text);
    const itemPhrase = /(?:PetBed|HempRope|BallGag|Hairbrush|窝窝|宠物窝|能躺进去睡觉的小窝|麻绳|口球|球塞|梳子)/i.test(text);
    if (!requestsAdd || !itemPhrase) return plan;

    let assets = [];
    if (/PetBed|窝窝|宠物窝|能躺进去睡觉的小窝/i.test(text) &&
        !/(?:狗窝|铁笼|笼子|重型狗窝)/.test(text)) {
      assets = ["PetBed"];
    } else if (/HempRope/i.test(text)) {
      assets = ["HempRope"];
    } else if (/麻绳/.test(text) &&
        typeof AssetGet === "function" &&
        AssetGet(target.AssetFamily, "ItemArms", "HempRope")) {
      assets = ["HempRope"];
    } else if (/BallGag/i.test(text)) {
      assets = ["BallGag"];
    } else if (/(?:口球|球塞)/.test(text) &&
        typeof AssetGet === "function" &&
        AssetGet(target.AssetFamily, "ItemMouth", "BallGag")) {
      assets = ["BallGag"];
    } else if (/Hairbrush/i.test(text)) {
      assets = ["Hairbrush"];
    } else if (/梳子/.test(text) &&
        typeof AssetGet === "function" &&
        AssetGet(target.AssetFamily, "ItemHandheld", "Hairbrush")) {
      assets = ["Hairbrush"];
    }
    let parts = [];
    if (assets[0] === "PetBed") parts = ["Devices"];
    else if (/(?:嘴|口|口球|球塞|BallGag)/i.test(text)) parts = ["Mouth"];
    else if (/(?:手臂|胳膊|绑手|HempRope)/i.test(text)) parts = ["Arms"];

    plan.intent = "action";
    plan.failed = false;
    plan.memorySearch = false;
    plan.memoryEntities = [];
    plan.stickerId = "";
    plan.needsCatalog = true;
    plan.operations = [{
      types: ["itemadd", "itemset"],
      targets: [Number(target.MemberNumber)],
      parts,
      assets,
    }];
    plan.goal = String(plan.goal || text).trim().slice(0, 200);
    plan.question = "";
    return plan;
  }

  function normalizePlannerColloquialItemAliases(plan, content) {
    if (plan?.intent !== "action") return plan;
    const text = stripQuotedSegments(content);
    if (!/(?:PetBed|窝窝|宠物窝|能躺进去睡觉的小窝)/i.test(text) ||
        /(?:狗窝|铁笼|笼子|重型狗窝)/.test(text)) return plan;
    for (const operation of plan.operations || []) {
      if (!(operation.types || []).some(type => type === "itemadd")) continue;
      operation.assets = ["PetBed"];
      operation.parts = ["Devices"];
    }
    return plan;
  }

  function normalizePlannerBroadDestructiveDecision(plan, content) {
    if (!plan || !["action", "clarify"].includes(plan.intent)) return plan;
    const text = stripQuotedSegments(content);
    if (plan.intent === "action" && plan.usedPendingClarification === true &&
        /^(?:御坂[，,：:\s]*)?(?:确认|确定|继续|是的|对|没错)(?:执行|继续)?[。.!！\s]*$/.test(text)) {
      return plan;
    }
    const broadText = /(?:所有人|全部人|全房间|大家).{0,16}(?:全脱|脱光|全部脱|都脱|全解|全部解)/.test(text) ||
      /(?:全脱|脱光|全部脱|都脱|全解|全部解).{0,16}(?:所有人|全部人|全房间|大家)/.test(text);
    const targets = new Set((plan.operations || [])
      .filter(operation => (operation.types || []).includes("itemdelall"))
      .flatMap(operation => operation.targets || []));
    if (!broadText && (plan.intent !== "action" || targets.size < 2)) return plan;
    plan.intent = "clarify";
    plan.failed = false;
    plan.memorySearch = false;
    plan.memoryEntities = [];
    plan.stickerId = "";
    plan.needsCatalog = false;
    plan.operations = [];
    plan.question = `这会清除${targets.size || "多"}个人身上的全部可移除道具，确定要继续吗？`;
    plan.broadDestructiveConfirmation = true;
    return plan;
  }

  function recoverExplicitCurrentItemOperation(plan, content) {
    const hasItemOperation = (plan?.operations || []).some(operation =>
      (operation?.types || []).some(type =>
        ["itemadd", "itemdel", "itemset", "itemcolor"].includes(type)));
    if (!plan || plan.failed || !["action", "clarify"].includes(plan.intent) ||
        hasItemOperation ||
        !Array.isArray(ChatRoomCharacter)) return plan;
    const text = stripQuotedSegments(content);
    const mentionedCharacters = ChatRoomCharacter.filter(character => {
      const displayName = String(character?.Nickname || character?.Name || "").trim();
      if (displayName.length < 2) return false;
      const escaped = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const asciiName = /^[\x00-\x7F]+$/.test(displayName);
      const pattern = asciiName
        ? new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "i")
        : new RegExp(escaped);
      return pattern.test(text);
    });
    if (mentionedCharacters.length !== 1) return plan;
    const target = mentionedCharacters[0];
    const mentionedItems = (target.Appearance || []).filter(item => {
      if (!item?.Asset?.Group?.Name?.startsWith("Item")) return false;
      const names = [
        item.Asset.Name,
        item.Asset.Description,
        assetCnName(item.Asset),
      ].map(value => String(value || "").trim()).filter(value => value.length >= 2);
      return names.some(name => /^[\x00-\x7F]+$/.test(name)
        ? text.toLowerCase().includes(name.toLowerCase())
        : text.includes(name));
    });
    const uniqueItems = [...new Map(mentionedItems.map(item =>
      [`${item.Asset.Group.Name}:${item.Asset.Name}`, item])).values()];
    if (uniqueItems.length !== 1) return plan;
    const item = uniqueItems[0];
    let type = "";
    if (/(?:取下|摘下|脱掉|去掉|移除|拿掉)/.test(text)) type = "itemdel";
    else if (/(?:改成|改为|换成|设成|设为).{0,12}(?:色|#[0-9a-f]{6})|(?:颜色|色).{0,8}(?:改|换|设)/i.test(text)) {
      type = "itemcolor";
    } else if (/(?:强度|震动|振动|档位|模式|样式|调到|调成|调为|设成|设为)/.test(text)) {
      type = "itemset";
    }
    if (!type) return plan;
    const semanticPart = Object.keys(BODY_PART_GROUPS).find(part =>
      (BODY_PART_GROUPS[part] || []).includes(item.Asset.Group.Name)) || "";
    plan.intent = "action";
    plan.memorySearch = false;
    plan.memoryEntities = [];
    plan.stickerId = "";
    plan.needsCatalog = true;
    plan.operations = [{
      types: [type],
      targets: [Number(target.MemberNumber)],
      parts: semanticPart ? [semanticPart] : [],
      assets: [item.Asset.Name],
    }];
    plan.question = "";
    return plan;
  }

  function recentConversationHasAnswer(content, senderNum) {
    const now = Date.now();
    const current = String(content || "").trim();
    const recent = state.recentMessages.slice(-10).filter(message => {
      if (message?.isSelf) return false;
      if (now - Number(message?.time || 0) > 5 * 60 * 1000) return false;
      return !(Number(message?.senderMemberNumber) === Number(senderNum) &&
        String(message?.content || "").trim() === current);
    });
    if (recent.length === 0) return false;

    const knownNames = new Set(["misaka", "御搬", "御坂", "搬运工"]);
    for (const character of ChatRoomCharacter || []) {
      for (const value of [character?.Name, character?.Nickname]) {
        const name = String(value || "").trim().toLowerCase();
        if (name.length >= 2) knownNames.add(name);
      }
    }
    for (const profile of Object.values(loadMemory()?.profiles || {})) {
      const name = String(profile?.name || "").trim().toLowerCase();
      if (name.length >= 2) knownNames.add(name);
    }
    const normalizeTopic = value => {
      let text = String(value || "").toLowerCase();
      for (const name of knownNames) text = text.split(name).join("");
      return text
        .replace(/[a-z][a-z0-9_-]*/gi, "")
        .replace(/(?:还记得|记不记得|以前|之前|上次|刚才|当时|当初|最后|说过|发生过|什么|怎么回事|为什么|是不是|是否|请问|告诉我|你听到了吗|了吗|了吗|呢|吗|谁)/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "");
    };
    const queryTopic = normalizeTopic(current);
    if (queryTopic.length < 2) return false;
    const queryBigrams = new Set();
    for (let index = 0; index < queryTopic.length - 1; index++) {
      queryBigrams.add(queryTopic.slice(index, index + 2));
    }
    return recent.some(message => {
      const recentTopic = normalizeTopic(
        `${message?.senderName || ""}${message?.content || ""}`);
      let overlap = 0;
      for (const bigram of queryBigrams) {
        if (recentTopic.includes(bigram)) overlap++;
      }
      return overlap >= 2;
    });
  }

  function isExplicitPastQuestion(content) {
    const text = String(content || "").trim();
    if (!text) return false;
    const asks = /[?？]|(?:吗|呢|什么|谁|怎么回事|为什么|记得|发生过|说过|做过)/.test(text);
    const past = /(?:还记得|记不记得|之前|以前|上次|昨天|前天|前几天|上周|当时|当初|后来|曾经|过去|来着)/.test(text);
    // “Rin为什么老说你笨”没有显式时间词，但仍是在追问跨多轮互动形成的
    // 历史原因。只对已知人物或御坂本人启用这条窄护栏，避免把
    // “猫为什么总是睡觉”一类常识问题误送进记忆检索。
    const habitual = /(?:为什么.*(?:老(?:是)?|总是|一直|经常)|(?:老(?:是)?|总是|一直|经常).*(?:说|叫|做|对|给))/.test(text);
    let mentionsKnownPerson =
      /(?:misaka|御搬|御坂|搬运工)/i.test(text) ||
      /(?:^|[，,\s])[A-Z][A-Za-z0-9_-]{1,31}(?=为什么|怎么|当时|以前|之前|上次)/.test(text);
    if (!mentionsKnownPerson) {
      const names = new Set();
      for (const character of ChatRoomCharacter || []) {
        for (const value of [character?.Name, character?.Nickname]) {
          const name = String(value || "").trim();
          if (name.length >= 2) names.add(name);
        }
      }
      for (const profile of Object.values(loadMemory()?.profiles || {})) {
        const name = String(profile?.name || "").trim();
        if (name.length >= 2) names.add(name);
      }
      mentionsKnownPerson = [...names].some(name => text.includes(name));
    }
    return asks && (past || (habitual && mentionsKnownPerson));
  }

  function isExplicitDurableFactQuestion(content) {
    const text = String(content || "")
      .replace(/^(?:御坂|御搬|misaka)\s*[，,：:\s]*/i, "")
      .trim();
    if (!text) return false;
    const match = text.match(
      /^([A-Za-z][A-Za-z0-9_-]{1,31}|[\p{Script=Han}]{2,16})(?:的)?(?:昵称|外号|别名)(?:是|叫)?什么|^([A-Za-z][A-Za-z0-9_-]{1,31}|[\p{Script=Han}]{2,16})(?:是|算)什么人/u,
    );
    const subject = String(match?.[1] || match?.[2] || "").trim();
    if (!subject) return false;
    const lowered = subject.toLowerCase();
    const knownNames = [];
    for (const character of ChatRoomCharacter || []) {
      knownNames.push(character?.Name, character?.Nickname);
    }
    for (const profile of Object.values(loadMemory()?.profiles || {})) {
      knownNames.push(profile?.name);
    }
    if (knownNames.some(value =>
      String(value || "").trim().toLowerCase() === lowered)) return true;
    return [...(state.refinedMemories || []), ...(state.semanticMemories || [])]
      .some(memory => String(memory?.text || "").toLowerCase().includes(lowered));
  }

  function normalizePlannerMemoryDecision(
    plan, content, senderNum, recentAnswerAvailableAtPlanStart) {
    const explicitPastNeedsSearch = isExplicitPastQuestion(content);
    const explicitFactNeedsSearch = isExplicitDurableFactQuestion(content);
    const recentAnswerAvailable =
      typeof recentAnswerAvailableAtPlanStart === "boolean"
        ? recentAnswerAvailableAtPlanStart
        : recentConversationHasAnswer(content, senderNum);
    // 显式过去式问句即使被模型随机判成 roleplay/action，也是在询问
    // 已发生的事实，而不是授权御坂现在执行或虚构。统一收口为 chat。
    if ((explicitPastNeedsSearch || explicitFactNeedsSearch) &&
        plan.intent !== "chat") plan.intent = "chat";
    const currentDaySmallTalk = /今天.{0,12}(?:发生|有).{0,10}(?:有趣|好玩).{0,4}(?:事|事情)/.test(
      String(content || ""),
    );
    // “为什么老是在自动更新房间”“最近怎么总掉线”描述的是眼前仍在发生的
    // 当前状态，而不是询问某次过去事件。habitual 规则只应用于人物之间的
    // 历史言行，不能把系统/房间当前状态误送进长期记忆回答器。
    const currentBehaviorText = String(content || "");
    const explicitlyDatedPast = /(?:还记得|记不记得|之前|以前|上次|昨天|前天|前几天|上周|当时|当初|后来|曾经|过去|来着)/.test(
      currentBehaviorText,
    );
    const currentBehaviorQuestion = !explicitlyDatedPast &&
      /(?:现在|目前|最近|老(?:是)?|总是|一直|经常).{0,20}(?:自动|更新|掉线|断线|卡住|卡顿|没反应|不回复|不说话|宕机|不稳定)/.test(
        currentBehaviorText,
      );
    plan.memorySearch = plan.intent === "chat" &&
      !recentAnswerAvailable &&
      !currentDaySmallTalk &&
      !currentBehaviorQuestion &&
      (plan.memorySearch === true || explicitPastNeedsSearch || explicitFactNeedsSearch);
    return plan;
  }

  function normalizeAssistantIdentity(reply, userContent) {
    let text = String(reply || "");
    const request = String(userContent || "").toLowerCase();
    if (!text) return text;
    // 咲/Misaki 是御坂的造主而不是御坂本人；即使她暂时不在房间名单中，
    // 也必须保留为固定的第三人身份。其余长期认识的人从人物档案补齐。
    const aliases = ["咲", "Misaki"];
    for (const character of ChatRoomCharacter || []) {
      if (Number(character?.MemberNumber) === Number(Player?.MemberNumber)) continue;
      for (const value of [character?.Nickname, character?.Name]) {
        const alias = String(value || "").trim();
        if (alias.length >= 1 && !aliases.includes(alias)) aliases.push(alias);
      }
    }
    for (const profile of Object.values(loadMemory()?.profiles || {})) {
      const alias = String(profile?.name || "").trim();
      if (alias.length >= 1 && !aliases.includes(alias)) aliases.push(alias);
    }
    aliases.sort((left, right) => right.length - left.length);
    for (const alias of aliases) {
      if (request.includes(alias.toLowerCase())) continue;
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // 只修正回复开头（或动作行之后）未被用户提及的人名自我归因。
      // 用户真的在询问“咲觉得什么”时，因为原问题含咲，不会改写第三人称。
      const selfAttribution = new RegExp(
        `(^|\\n)${escaped}(?=(?:觉得|认为|感觉|想|希望|知道|不知道|明白|不明白|会|不会|可能|应该|有点|正在|刚才))`,
        "g",
      );
      text = text.replace(selfAttribution, "$1我");
    }
    return text;
  }

  function normalizePlannerActivityDecision(plan, content, senderNum) {
    if (!["activity", "clarify", "roleplay"].includes(plan?.intent)) return plan;
    const text = stripQuotedSegments(content);
    if (!text || /(?:假装|动作描写|星号动作|表演|演一下|\*)/.test(text)) return plan;

    // “帮我梳头/整理头发/编辫子”的目标由语法直接确定为发送者。规划器
    // 偶尔会随机漂到 clarify/roleplay，但这类请求既没有目标歧义，也已有
    // BC 原生 TakeCare@ItemHead，可安全确定性收口。
    const selfHairCare = /(?:帮|给|替)我.{0,6}(?:梳(?:一?下)?头|整理(?:一?下)?头发|编(?:一?下)?辫子)/.test(text);
    const senderNumber = Number(senderNum);
    if (selfHairCare && Number.isFinite(senderNumber) &&
        (ChatRoomCharacter || []).some(character => Number(character?.MemberNumber) === senderNumber)) {
      plan.intent = "activity";
      plan.memorySearch = false;
      plan.memoryEntities = [];
      plan.stickerId = "";
      plan.operations = [];
      plan.activity.target = senderNumber;
      plan.activity.request = String(plan.activity.request || text).trim().slice(0, 160);
      plan.question = "";
      return plan;
    }

    // DeepSeek 偶尔能保留 Activity 请求，却随机丢掉或替换文本中已经明确
    // 点名的目标。这里只接受“互动动词与唯一房间人名相邻”的窄模式；
    // “摸摸她”或“某人摸我”仍交给规划器继续澄清。
    const interaction = "(?:抚摸|摸摸|摸|拥抱|抱抱|抱|亲吻|亲一下|亲|吻|舔|咬|拍打|拍|挠痒|挠|揉|捏|戳|蹭|梳(?:一?下)?头|整理(?:一?下)?头发|编(?:一?下)?辫子)";
    const matchedTargets = new Map();
    for (const character of ChatRoomCharacter || []) {
      const memberNumber = Number(character?.MemberNumber);
      if (!Number.isFinite(memberNumber) ||
          memberNumber === Number(Player?.MemberNumber)) continue;
      const aliases = [...new Set([
        character?.Nickname,
        character?.Name,
        `#${memberNumber}`,
      ].map(value => String(value || "").trim()).filter(value => value.length >= 2))]
        .sort((left, right) => right.length - left.length);
      for (const alias of aliases) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(
          `(?:${interaction}.{0,12}${escaped}|${escaped}.{0,12}${interaction})(?![A-Za-z0-9_#-])`,
          "i",
        ).test(text)) {
          matchedTargets.set(memberNumber, character);
          break;
        }
      }
    }
    if (matchedTargets.size !== 1) return plan;
    plan.intent = "activity";
    plan.memorySearch = false;
    plan.memoryEntities = [];
    plan.stickerId = "";
    plan.operations = [];
    plan.activity.target = [...matchedTargets.keys()][0];
    plan.activity.request = String(plan.activity.request || text).trim().slice(0, 160);
    plan.question = "";
    return plan;
  }

  function getPendingClarification(senderNum) {
    const key = String(Number(senderNum));
    const pending = state.pendingClarifications[key];
    if (!pending) return null;
    if (Date.now() - Number(pending.updatedAt || 0) > CONFIG.clarificationTtlMs) {
      delete state.pendingClarifications[key];
      return null;
    }
    return pending;
  }

  function rememberPendingClarification(senderNum, senderName, content, plan, previous) {
    const key = String(Number(senderNum));
    const originContent = previous?.originContent || String(content || "").slice(0, 400);
    const turns = previous
      ? [...(previous.turns || []), {
          answer: String(content || "").slice(0, 180),
          question: String(plan?.question || "").slice(0, 300),
        }].slice(-3)
      : [{ answer: "", question: String(plan?.question || "").slice(0, 300) }];
    const context = [
      `原始请求:${senderName}#${senderNum}: ${originContent}`,
      ...turns.flatMap(turn => [
        turn.answer ? `用户回答:${turn.answer}` : "",
        `御坂追问:${turn.question}`,
      ].filter(Boolean)),
    ].join("\n");
    state.pendingClarifications[key] = {
      senderNum: Number(senderNum),
      senderName: String(senderName || ""),
      originContent,
      turns,
      context: context.slice(0, 2000),
      updatedAt: Date.now(),
    };
    return state.pendingClarifications[key];
  }

  function clearPendingClarification(senderNum) {
    delete state.pendingClarifications[String(Number(senderNum))];
  }

  function normalizeReplacementPlanOperations(plan) {
    if (!plan?.constraints?.replaceExisting) return plan;
    const replacementTargets = [...new Set((plan.operations || []).flatMap(op => op.targets || []))];
    for (const target of replacementTargets) {
      const char = actionTargetCharacter(target);
      if (!char) continue;
      const ops = plan.operations.filter(op => (op.targets || []).includes(target) && op.assets.length > 0);
      const assetIsWorn = assetName => {
        const mapping = findItemAsset(assetName, char);
        return !!mapping && (char.Appearance || []).some(a =>
          a?.Asset?.Name === mapping.asset && a?.Asset?.Group?.Name === mapping.group);
      };
      const hasNewAsset = ops.some(op => op.assets.some(asset => !assetIsWorn(asset)));
      if (!hasNewAsset) continue;
      for (const op of ops) {
        if (op.parts.length === 0) {
          const inferredParts = [...new Set(op.assets.map(asset => {
            const mapping = findItemAsset(asset, char);
            return Object.keys(BODY_PART_GROUPS).find(part =>
              (BODY_PART_GROUPS[part] || []).includes(mapping?.group)) || "";
          }).filter(Boolean))];
          if (inferredParts.length === 1) op.parts = inferredParts;
        }
        const newAssets = op.assets.filter(asset => !assetIsWorn(asset));
        if (newAssets.length === 0 && op.assets.some(assetIsWorn)) {
          op._replacementDeleteOnly = true;
        } else if (newAssets.length > 0) {
          op.assets = newAssets;
        }
      }
    }
    return plan;
  }

  // 自然语言操作规划由独立 LLM 调用完成。执行层不再用关键词/正则猜测用户意图。
  async function planUserRequest(senderNum, senderName, content, pendingClarification) {
    const roster = (typeof MisakaPersona !== "undefined" && Array.isArray(ChatRoomCharacter))
      ? MisakaPersona.buildCompactRoster(ChatRoomCharacter, Player.MemberNumber)
      : `御坂#${Player?.MemberNumber || "?"}; ${senderName}#${senderNum}`;
    const senderChar = Number(senderNum) === Number(Player?.MemberNumber)
      ? Player
      : (ChatRoomCharacter || []).find(c => Number(c.MemberNumber) === Number(senderNum));
    const senderItems = (senderChar?.Appearance || [])
      .filter(a => a?.Asset?.Group?.Name?.startsWith("Item"))
      .map(a => {
        const tr = a.Property?.TypeRecord && Object.keys(a.Property.TypeRecord).length
          ? ` TypeRecord=${JSON.stringify(a.Property.TypeRecord)}`
          : "";
        return `${a.Asset.Group.Name}:${a.Asset.Name}${tr}`;
      }).join("; ") || "无";
    const deviceCatalog = getPlannerDeviceCatalog();
    const handheldCatalog = getPlannerHandheldCatalog();
    const recentContext = buildPlannerRecentContext(10);
    const refinedFacts = (state.refinedMemories || []).slice(-CONFIG.maxRefinedMemories)
      .map(m => String(m?.text || m || "").trim()).filter(Boolean).join("\n").slice(-4000);
    const stickerCatalog = compactStickerCatalog();
    // callLLM 返回前房间可能继续收到消息。这个判定必须与上面构造的
    // recentContext 使用同一时刻的快照，不能在数秒后重新读取滚动窗口。
    const recentAnswerAvailableAtPlanStart =
      recentConversationHasAnswer(content, senderNum);
    const plannerPrompt = `你是 BC 请求规划器。只输出一行严格 JSON，不要 markdown，不要回复用户。
根据最新消息判断是 chat、roleplay、activity、friendship、action 还是 clarify。自然语言含糊但有常见合理解释时不要急着 clarify。
activity 是对房间内真实人物进行身体互动时的默认优先选择，例如摸头、拥抱、亲吻、舔、咬、拍打、挠痒等；不要求用户明确说“BC/官方/原生动作”。activity 必须指定房间内真实目标，activity.target 填目标编号，activity.request 用短句保留动作与身体部位。执行层会从 BC 当下允许的原生 Activity 目录中选择语义吻合项；没有合适原生动作时再安全降级为 *动作描写*。
roleplay 只用于用户明确要求文字/星号动作描写、假装、表演、躲藏、探头、虚构当前无法作为房间人物定位的动作，或把手持食物递到嘴边、把某人的手腿当食物、“该怎么办/强硬一点”这类现场演出。不得因为用户没说“BC/官方/原生”就选 roleplay，也不得为了 roleplay 规划真实道具指令。
friendship 只表示房间成员本人明确要求御坂把自己加为 BC 好友，例如“御坂加我好友”“可以把我加进好友吗”。friendship.target 必须等于当前说话者编号，friendship.explicit=true。第三人要求御坂添加别人、泛泛说“我们是朋友”、夸赞某人或普通友好聊天都不是 friendship；不得替目标本人作出好友请求。
action 只用于确实要改变 BC 状态的移动、添加/删除/设置道具、快照、复制或游戏表情。只有执行真实 action 所必需的目标或操作仍无法确定时才选 clarify。
用户已经说出常见且足以从实时目录选择道具的类别、用途或别名（如麻绳、口球、梳子、窝窝、能躺进去睡觉的小窝）时，必须规划 action 并设置 needsCatalog=true；若无法唯一对应精确 Asset，就把 operations.assets 留空交给主模型按完整目录选择，不能反问用户“具体哪一种道具”。
必须利用“近期对话”理解“也要”“那个”“手一份腿两份”等指代和延续玩笑，但永远只处理最新消息，不补做历史请求。
近期对话中带【显式纠正】的后一句是说话者对同话题较早说法的更正，应按后一句理解，不得把已纠正的两句并列成无法判断的矛盾。
手持食物需要区分三种语义：把食物递到嘴边、喂一口、吃掉或把某人的手腿当食物，通常是 roleplay；“给B一个/一份X”“给B点吃的”表示让B实际拿到 ItemHandheld，规划 action，若上文已有明确食物则沿用，未明确时优先选择目录里常见且无害的食物而不是反复追问；“把A手里的X给B”默认给B添加同类手持物但不删除A手里的，只有明确说“拿走、转移、从A手里移交”时才规划先从A移除再给B添加。鸡腿、香肠、爆米花等可能是同一道具的不同样式，必须结合 ItemHandheld 目录中的样式选项保留在 goal 中，不要把样式名误当成不存在的 Asset。
若存在“待澄清上下文”，判断最新消息是否在回答御坂上一轮的追问。像“狗窝”“红色”“咲”“手臂”这样的短答必须与原始请求合并理解，并继承原请求的目标人物、操作和限制，不得当成孤立的新命令。此时 usedPendingClarification=true；若最新消息明显是新话题，则为 false。
在承接追问时，“御坂，狗窝”中的“御坂”通常只是对助手的称呼，不表示把御坂作为操作目标。只有“把御坂/给御坂/让你自己”等明确宾语表达才改变目标人物。
actionTypes 只能从 itemadd,itemdel,itemdelall,itemset,itemcolor,move,moveTo,moveEdge,snapshotSave,snapshotRestore,copyRestraint,emote 中选择。
把语义相容的类型都列出，例如“绑成某种绑法”通常允许 itemadd 和 itemset；“换个更严格的绑法”也可允许先移除再添加。
operations.assets 用于保存用户已经明确选中的精确 Asset 名称。若设备目录把“狗窝”映射为 LowCage，就必须写 assets:["LowCage"]；不得再写 PetBed，也不得只保留中文描述让主模型重新猜。用户没有明确选定具体道具时才留空数组。
targets 必须使用房间名单中的编号，且永远表示“被实际操作的人”。“我/给我/把我”指说话者#${senderNum}；“你/御坂/你自己”指御坂#${Player?.MemberNumber || "?"}。moveTo 中即使目的地是御坂，targets 仍填写被移动者，不能填写参照人物。
parts 只在用户明确限定单一身体部位或设备位时填写标准值 Arms/Hands/Legs/Feet/Mouth/Head/Neck/Torso/Pelvis/Breast/Eyes/Ears/Vulva/Devices，否则空数组。笼子、家具、机器等 ItemDevices 统一规划为 Devices。中文“绑手/把手绑住/手上的麻绳/手铐”在 BC 中通常属于整条手臂束缚，规划为 Arms；只有明确说手掌、手指或指定 ItemHands 道具时才规划为 Hands。LeatherDeluxeCuffs 固定属于 Arms。
needsCatalog 表示是否涉及道具、穿着、束缚、属性或颜色；移动/表情/闲聊为 false。
MOVE/moveTo/moveEdge 只表示聊天室人物头像的横向站位（左移、右移、移到某人旁边、移到边缘）。它们绝不表示进入、躺进、关进、塞进、坐进、装进或使用某个道具/容器。
用户要求人物进入、离开或被放入某种设备、容器、家具时，必须视为 ItemDevices 道具状态操作：needsCatalog=true，并规划 itemadd/itemdel/itemset；若当前 ItemDevices 是另一件设备而目标要求换成新设备，应允许 itemdel+itemadd+itemset，并设置 replaceExisting=true、noStack=true。不得把相邻站位冒充进入设备。
设备名称必须区分精确 Asset；PetBed（宠物窝）、Cage（站立式铁笼）、LowCage（狗窝）、PersonalCage（单人铁笼）、Kennel（重型狗窝）不是同一件道具。
goal 用一句短话保留用户真正想达到的最终状态（例如“驷马缚”“更严格但不叠加”），不要只写“操作道具”。
constraints 只记录用户明确表达的限制：noMove=禁止移动，noAdd=禁止新增，replaceExisting=替换而非叠加，noStack=不要叠加；preserveParts 是明确要求不要碰的部位。
记忆查询规则：
- memorySearch=true 只用于询问过去的具体事件、原话、经历、偏好或“为什么当时那样”，且答案没有明确出现在近期对话或概括记忆中。
- “还记得Rikka说要吃你吗”“Sally当时给了你什么”“我以前说过最喜欢什么颜色”应为 true。
- 当前时间、当前房间、当前穿着/道具、普通闲聊、观点提问、角色扮演、真实操作，以及概括记忆已经明确回答的问题应为 false。
- 不要因为问题听起来虚构就跳过查询；只要它在询问过去是否发生过，也应查询后再判断没有记忆。
- memoryEntities 只列问题涉及的人名；“我/我以前”加入说话者 ${senderName}，“你/御坂”加入御坂。保留原问题里的主客体，不改写事件。
- memorySearch 与 activity/friendship/action/roleplay/clarify 不并用；这些意图下必须为 false。
表情包规则：
- stickerId 只能从“御坂表情包目录”的 ID 中选择，或者为空字符串。绝不能输出网址或发明 ID。
- 只在 chat 或 roleplay 中出现清晰、强烈且与目录高度匹配的情绪时选择；普通对话、记忆回答、activity、action、clarify 一律为空。
- 若用户明确描述御坂本人正在“气鼓鼓/不服气”“被调戏得惊慌脸红”“委屈难过到掉眼泪”或“突然明白/恍然大悟”，优先选择对应表情；不要因为同一句同时包含安慰、道歉或玩笑而漏掉已经明确成立的强情绪。
- pout 只用于玩闹式不满，不用于严肃冲突；tearful 只用于委屈伤心，不用于喜极而泣；sudden_realization 只用于突然听懂或发现重点，不用于普通思考。
- 表情包是偶尔的情绪补充，不是每轮必发。只能根据目录中的 label 和 tags 判断匹配。
- “突然！送你一份意想不到的礼物”“吓你一跳”是可直接回应的 chat/roleplay，不需要执行真实操作，也不得选 clarify。
格式:{"intent":"activity|friendship|action|chat|roleplay|clarify","memorySearch":false,"memoryEntities":[],"stickerId":"","usedPendingClarification":false,"needsCatalog":false,"goal":"最终目标","activity":{"target":123,"request":"摸摸她的头"},"friendship":{"target":123,"explicit":true},"constraints":{"noMove":false,"noAdd":false,"replaceExisting":false,"noStack":false,"preserveParts":[]},"operations":[],"question":""}
operations 每项必须使用 types 数组；不要输出单数 type。执行层会兼容单数 type，但标准输出始终是 types。
action 操作项示例:{"types":["moveEdge"],"targets":[123],"parts":[],"assets":[]}
房间名单:${roster}
说话者当前实时道具:${senderItems}
ItemDevices 紧凑目录:${deviceCatalog || "不可用"}
ItemHandheld 紧凑目录:${handheldCatalog || "不可用"}
近期对话:${recentContext || "无"}
概括记忆:${refinedFacts || "无"}
御坂表情包目录:${stickerCatalog || "无"}
待澄清上下文:${pendingClarification?.context || "无"}
当前实时道具高于历史对话。调整/收紧/替换现有道具时，以这里是否存在为准；存在则应规划 action，不存在才 clarify。`;
    const result = await callLLM(plannerPrompt, [{ role: "user", content: `最新消息:${senderName}#${senderNum}: ${content}` }], {
      // 保留 DeepSeek thinking；规划结果虽短，但推理过程与最终 JSON 共用
      // max_tokens，必须给 reasoning_content 留出充足预算。
      thinking: true,
      maxTokens: 2048,
    });
    try {
      const match = String(result || "").match(/\{[\s\S]*\}/);
      const plan = JSON.parse(match ? match[0] : "");
      if (!["action", "activity", "friendship", "chat", "roleplay", "clarify"].includes(plan.intent)) throw new Error("invalid intent");
      plan.memoryEntities = (Array.isArray(plan.memoryEntities) ? plan.memoryEntities : [])
        .map(v => String(v || "").trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 4);
      const validStickerIds = new Set(getStickerCatalog().map(sticker => sticker.id));
      plan.stickerId = validStickerIds.has(String(plan.stickerId || ""))
        ? String(plan.stickerId)
        : "";
      // 规划器是主判定；这条极窄的确定性护栏只防止显式过去式问句被随机漏判。
      // 即使答案已在概括记忆里，多做一次检索也比绕过证据后直接编造更安全。
      // “当初谁……”“某人当时怎么称呼……”已经是完整的历史问题。
      // 规划器偶发误判 intent 时由确定性历史问句护栏收口，不让随机性
      // 制造无意义追问、虚构演出或意外操作。
      normalizePlannerMemoryDecision(
        plan, content, senderNum, recentAnswerAvailableAtPlanStart);
      normalizePlannerQuotedReportDecision(plan, content);
      normalizePlannerSimpleRoleplayDecision(plan, content);
      plan.usedPendingClarification = !!pendingClarification && plan.usedPendingClarification === true;
      const validTypes = new Set(["itemadd","itemdel","itemdelall","itemset","itemcolor","move","moveTo","moveEdge","snapshotSave","snapshotRestore","copyRestraint","emote"]);
      const validParts = new Set(["Arms","Hands","Legs","Feet","Mouth","Head","Neck","Torso","Pelvis","Breast","Eyes","Ears","Vulva","Devices"]);
      const roomNumbers = new Set((ChatRoomCharacter || []).map(c => Number(c.MemberNumber)));
      if (Player?.MemberNumber) roomNumbers.add(Number(Player.MemberNumber));
      const activityTarget = Number(plan?.activity?.target);
      plan.activity = {
        target: roomNumbers.has(activityTarget) ? activityTarget : null,
        request: String(plan?.activity?.request || plan.goal || "").trim().slice(0, 160),
      };
      normalizePlannerActivityDecision(plan, content, senderNum);
      const friendTarget = Number(plan?.friendship?.target);
      plan.friendship = {
        target: roomNumbers.has(friendTarget) ? friendTarget : null,
        explicit: plan?.friendship?.explicit === true,
      };
      // 关系请求不能误入 Activity 或道具操作。模型偶尔会把
      // “把某人加为好友”理解成对该人物执行动作；这里仅识别明确的
      // “加好友”请求，并把第三方请求收口为边界说明。
      const unquotedContent = stripQuotedSegments(content);
      const asksToAddFriend = /(?:加|添加).{0,8}(?:好友|朋友)|(?:好友|朋友).{0,8}(?:加|添加)/.test(unquotedContent);
      const explicitSelfFriendRequest = asksToAddFriend && (
        /(?:把|将)?我(?:加|添加)(?:为|成)?(?:好友|朋友)/.test(unquotedContent) ||
        /(?:加|添加)(?:我|本人)(?:为|成)?(?:好友|朋友)/.test(unquotedContent) ||
        /(?:和|跟)我(?:加个|成为|做)?(?:好友|朋友)/.test(unquotedContent) ||
        /我们(?:加个|成为|做)?(?:好友|朋友)/.test(unquotedContent)
      );
      if (explicitSelfFriendRequest) {
        // 明确的本人请求不需要继续赌规划器的随机分类；这是一个可由文本与
        // senderNum 完全确定的边界。
        plan.intent = "friendship";
        plan.memorySearch = false;
        plan.stickerId = "";
        plan.operations = [];
        plan.friendship = { target: Number(senderNum), explicit: true };
      } else if (asksToAddFriend) {
        plan.intent = "clarify";
        plan.memorySearch = false;
        plan.stickerId = "";
        plan.operations = [];
        plan.question = "好友关系要由本人提出哦。";
      }
      if (plan.intent === "friendship" && !explicitSelfFriendRequest) {
        // “想成为朋友/我们是朋友”属于社交表达，不等价于修改 BC 好友名单。
        // 只有上面的显式“加/添加好友”文本可以进入原生关系写入。
        plan.intent = "chat";
        plan.friendship = { target: null, explicit: false };
      }
      plan.operations = normalizePlannerOperations(plan.operations, roomNumbers, validTypes, validParts);
      normalizePlannerExplicitActionTargets(plan, content);
      normalizePlannerHandheldGiveDecision(plan, content, senderNum);
      normalizePlannerExpiredHandheldReplacement(plan, content);
      normalizePlannerExplicitItemAddDecision(plan, content);
      normalizePlannerColloquialItemAliases(plan, content);
      normalizePlannerAmbiguousSingleItemDecision(plan, content);
      normalizePlannerBroadDestructiveDecision(plan, content);
      if (plan.operations.some(op => op.types.some(t => ["itemadd","itemdel","itemdelall","itemset","itemcolor","snapshotRestore","copyRestraint"].includes(t)))) {
        plan.needsCatalog = true;
      }
      plan.goal = typeof plan.goal === "string" ? plan.goal.trim().slice(0, 200) : "";
      const rawConstraints = (plan.constraints && typeof plan.constraints === "object") ? plan.constraints : {};
      plan.constraints = {
        noMove: rawConstraints.noMove === true,
        noAdd: rawConstraints.noAdd === true,
        replaceExisting: rawConstraints.replaceExisting === true,
        noStack: rawConstraints.noStack === true,
        preserveParts: (Array.isArray(rawConstraints.preserveParts) ? rawConstraints.preserveParts : []).filter(p => validParts.has(p)),
      };
      recoverExplicitCurrentItemOperation(plan, content);
      enrichPlannerAssetsFromExplicitMentions(plan, content);
      if (plan.intent === "chat" || plan.intent === "roleplay" ||
          plan.intent === "activity" || plan.intent === "friendship") {
        plan.needsCatalog = false;
        plan.operations = [];
      }
      if (plan.intent !== "chat") {
        plan.memorySearch = false;
        plan.memoryEntities = [];
      }
      if (!["chat", "roleplay"].includes(plan.intent) || plan.memorySearch) plan.stickerId = "";
      // 规划器偶尔会把“删掉当前旧设备”和“添加新设备”拆成两个都含
      // itemadd/itemset 的 operation。替换场景下，若同一目标同时出现当前已穿
      // Asset 与未穿 Asset，前者只能是待删除旧物，不能再次添加。
      normalizeReplacementPlanOperations(plan);
      // 基于规划器已经给出的结构化道具意图补全“添加后调样式”的客观操作族，
      // 不再回头用原始中文关键词猜语义。命名绑法往往同时需要 ITEMADD + ITEMSET。
      for (const op of plan.operations) {
        if (op._replacementDeleteOnly) {
          op.types = ["itemdel"];
          delete op._replacementDeleteOnly;
          continue;
        }
        const types = new Set(op.types);
        if (types.has("itemadd")) types.add("itemset");
        if (plan.constraints.replaceExisting || plan.constraints.noStack) {
          types.add("itemdel");
          if (!plan.constraints.noAdd) types.add("itemadd");
          types.add("itemset");
        }
        if (plan.constraints.noAdd) types.delete("itemadd");
        op.types = [...types];
      }
      if (plan.intent === "action" && plan.operations.length === 0) {
        plan.intent = "clarify";
        plan.question = plan.question || "你想让我对谁做什么？";
      }
      if (plan.intent === "activity" && (!plan.activity.target || !plan.activity.request)) {
        plan.intent = "clarify";
        plan.question = plan.question || "你想让我用 BC 动作对谁做什么？";
      }
      if (plan.intent === "friendship" &&
          (!plan.friendship.explicit || Number(plan.friendship.target) !== Number(senderNum))) {
        plan.intent = "clarify";
        plan.question = "好友关系要由本人提出哦。";
      }
      return plan;
    } catch (e) {
      console.warn("[MisakaChat] 请求规划失败:", e.message, result);
      let fallbackPlan = normalizePlannerHandheldGiveDecision({
        intent: "clarify",
        memorySearch: false,
        memoryEntities: [],
        usedPendingClarification: false,
        needsCatalog: false,
        operations: [],
        question: "我没听明白要做什么，能再说具体一点吗？",
        failed: true,
      }, content, senderNum);
      fallbackPlan = normalizePlannerExpiredHandheldReplacement(fallbackPlan, content);
      fallbackPlan = normalizePlannerExplicitItemAddDecision(fallbackPlan, content);
      return normalizePlannerBroadDestructiveDecision(fallbackPlan, content);
    }
  }

  function getSystemPrompt(includeCatalog) {
    const mem = loadMemory();
    if (typeof MisakaPersona === "undefined") {
      return `你是御坂 (Misaka),Bondage Club 中 Gimp Dolls 房间的管理员。安静、简短、偶尔傲娇。中文为主,回复不超过50字。不提及AI或现实信息。`;
    }

    // 缓存房间名单:人员变化或超过 30 秒才重建
    let roster = "";
    if (typeof ChatRoomCharacter !== "undefined" && Array.isArray(ChatRoomCharacter) && typeof Player !== "undefined") {
      const snapshot = ChatRoomCharacter.map(c => c.MemberNumber + ":" + (c.Nickname || c.Name)).join(",");
      const now = Date.now();
      if (snapshot === _rosterCache.snapshot && now - _rosterCache.time < 30000) {
        roster = _rosterCache.roster; // 用缓存
      } else {
        roster = MisakaPersona.buildCompactRoster(ChatRoomCharacter, Player.MemberNumber);
        _rosterCache = { snapshot, roster, time: now };
      }
    }
    mem.roster = roster;
    mem.profiles = selectPromptProfiles(mem.profiles || {});
    if (includeCatalog !== false) mem.itemCatalog = getItemCatalog();


    // 长期提炼记忆
    if (state.refinedMemories && state.refinedMemories.length > 0) {
      mem.refined = state.refinedMemories.slice(-CONFIG.maxRefinedMemories);
    }

    // 注入当前时间,让御坂知道几点
    mem.currentTime = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    mem.currentDate = new Date().toLocaleDateString('zh-CN');
    const dayOfWeek = ['日','一','二','三','四','五','六'][new Date().getDay()];
    mem.currentDayOfWeek = `星期${dayOfWeek}`;

    // 注入进出记录
    if (state.roomLog && state.roomLog.length > 0) {
      mem.roomLog = state.roomLog.slice(-10).map(e => e.text).join("\n");
    }

    const personaExtra = localStorage.getItem(storageKey("persona_extra")) || "";
    if (personaExtra) mem.personaExtra = personaExtra.slice(0, 1000);

    return MisakaPersona.build(mem, includeCatalog !== false);
  }

  // === [Actions] 操作指令解析 ===
  // 支持3种MOVE格式:
  //   [MOVE:166706:left]           - 往左移一步
  //   [MOVE:166706:right]          - 往右移一步
  //   [MOVE:166706:to:182401:left]  - 把166706移到182401左边(自动多步)
  //   [MOVE:166706:to:182401:right] - 把166706移到182401右边(自动多步)
  function parseActionCommands(reply) {
    const commands = [];
    // 单次从左到右扫描，严格保留模型输出顺序。过去按类型连续 replace 会把
    // DEL → ADD → SET 重排成 ADD → SET → DEL，导致替换操作最后反而删掉新道具。
    const cleaned = String(reply || "").replace(/\[([A-Z]+):([^\]]*)\]/gi, (raw, rawType, body) => {
      const type = rawType.toUpperCase();
      const parts = String(body).split(":").map(s => s.trim());
      const mn = Number(parts[0]);
      const hasMemberNumber = /^\d+$/.test(parts[0] || "");
      let cmd = null;
      if (type === "MEMSEARCH" && body.trim()) cmd = { type: "memsearch", query: body.trim() };
      else if (type === "BCEQUERY" && body.trim()) cmd = { type: "bcequery", target: body.trim() };
      else if (type === "MOVE" && hasMemberNumber) {
        if (parts[1] === "to" && /^\d+$/.test(parts[2] || "") && /^(left|right)$/i.test(parts[3] || ""))
          cmd = { type: "moveTo", memberNumber: mn, targetNumber: Number(parts[2]), side: parts[3].toLowerCase() };
        else if (parts[1] === "edge" && /^(left|right)$/i.test(parts[2] || ""))
          cmd = { type: "moveEdge", memberNumber: mn, edge: parts[2].toLowerCase() };
        else if (/^(left|right)$/i.test(parts[1] || ""))
          cmd = { type: "move", memberNumber: mn, direction: parts[1].toLowerCase() };
      } else if (type === "ITEMADD" && hasMemberNumber && parts[1]) {
        const item = parts[1];
        const part = parts[2] || "";
        const tail = parts.slice(3).join(":");
        const isColor = !tail || !!colorNameToHex(tail);
        cmd = { type: "itemadd", memberNumber: mn, item, part, color: isColor ? tail : "" };
        // 模型偶尔把 typed 样式误写在 ITEMADD 第五段（如 :Arms:BoxTie）。
        // 该位置若不是合法颜色，就按原顺序补成紧随其后的 ITEMSET，而非报“未知颜色”。
        if (tail && !isColor) {
          commands.push(cmd);
          commands.push({ type: "itemset", memberNumber: mn, item, part, property: "样式", value: tail });
          return "";
        }
      } else if (type === "ITEMDEL" && hasMemberNumber && parts[1]) {
        cmd = parts[1].toLowerCase() === "all"
          ? { type: "itemdelall", memberNumber: mn }
          : { type: "itemdel", memberNumber: mn, item: parts[1], part: parts.slice(2).join(":") };
      } else if (type === "ITEMCOLOR" && hasMemberNumber && parts[1] && parts.length >= 3) {
        cmd = parts.length >= 4
          ? { type: "itemcolor", memberNumber: mn, item: parts[1], part: parts[2], color: parts.slice(3).join(":") }
          : { type: "itemcolor", memberNumber: mn, item: parts[1], part: "", color: parts[2] };
      } else if (type === "ITEMSET" && hasMemberNumber && parts[1] && parts.length >= 4) {
        const item = parts[1];
        const hasBodyPart = !!BODY_PART_GROUPS[parts[2]];
        const explicitEmptyPart = parts[2] === "" && parts.length >= 5;
        const part = hasBodyPart ? parts[2] : "";
        const propertyIndex = (hasBodyPart || explicitEmptyPart) ? 3 : 2;
        const value = parts.slice(propertyIndex + 1).join(":");
        const property = parts[propertyIndex];
        if (property && value) {
          if (/^#[0-9A-Fa-f]{6}$/.test(value) || /^(默认|Default|原色)$/.test(value))
            cmd = { type: "itemcolor", memberNumber: mn, item, part: property, color: value };
          else cmd = { type: "itemset", memberNumber: mn, item, part, property, value };
        }
      } else if (type === "SNAPSHOT" && /^(save|restore)$/i.test(parts[0] || "") && /^\d+$/.test(parts[1] || "")) {
        cmd = { type: parts[0].toLowerCase() === "save" ? "snapshotSave" : "snapshotRestore", memberNumber: Number(parts[1]) };
      } else if (type === "COPY" && hasMemberNumber && parts[1] === "to" && /^\d+$/.test(parts[2] || "")) {
        cmd = { type: "copyRestraint", sourceNumber: mn, targetNumber: Number(parts[2]) };
      } else if (type === "EMOTE" && hasMemberNumber && parts.slice(1).join(":").trim()) {
        cmd = { type: "emote", memberNumber: mn, expression: parts.slice(1).join(":").trim() };
      }
      if (!cmd) return raw; // 未识别或格式错误的标签保留，避免静默吞字。
      commands.push(cmd);
      return "";
    });
    return { commands, cleaned: cleaned.trim() };
  }

  const STRUCTURED_REPLY_PROTOCOL = "misaka.reply.v1";
  const VISIBLE_ACTION_MAX_GRAPHEMES = 80;
  const VISIBLE_SPEECH_MAX_GRAPHEMES = 320;

  function extractFirstBalancedJsonObject(value) {
    const text = String(value || "");
    const start = text.indexOf("{");
    if (start < 0) return "";
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return "";
  }

  function completeTruncatedJsonObject(value) {
    const text = String(value || "").trim();
    if (!text.startsWith("{")) return "";
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (const char of text) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") stack.push("}");
      else if (char === "[") stack.push("]");
      else if (char === "}" || char === "]") {
        if (stack.pop() !== char) return "";
      }
    }
    if (quoted || escaped || stack.length === 0 || /[:,\\]$/.test(text)) return "";
    return text + stack.reverse().join("");
  }

  function structuredReplyInstruction() {
    return `【最终回复协议：${STRUCTURED_REPLY_PROTOCOL}】
只输出一个严格 JSON 对象，不要 Markdown 代码块，不要在 JSON 前后添加文字：
{"protocol":"${STRUCTURED_REPLY_PROTOCOL}","commands":[],"action":"","speech":""}
- commands 必须是对象数组。聊天和文字角色扮演时为空数组。
- action 只写动作内容，不写 *；没有动作时为空字符串。
- speech 只写台词，不写名字前缀、星号或操作指令；没有台词时为空字符串。
- 不得把动作混入 speech，也不得把台词混入 action。
- MOVE: {"type":"move","memberNumber":123,"direction":"left|right"}
- 移到某人旁边: {"type":"moveTo","memberNumber":123,"targetNumber":456,"side":"left|right"}
- 移到边缘: {"type":"moveEdge","memberNumber":123,"edge":"left|right"}
- 添加: {"type":"itemadd","memberNumber":123,"item":"AssetName","part":"Arms、Devices、ItemDevices或空","color":"#RRGGBB或空"}
- 移除: {"type":"itemdel","memberNumber":123,"item":"AssetName","part":"Arms、Devices、ItemDevices或空"}
- 全部释放: {"type":"itemdelall","memberNumber":123}
- 改色: {"type":"itemcolor","memberNumber":123,"item":"AssetName","part":"layer或空","color":"#RRGGBB"}
- 设置属性: {"type":"itemset","memberNumber":123,"item":"AssetName","part":"Arms、Devices、ItemDevices或空","property":"属性名","value":"值"}
- 快照: {"type":"snapshotSave|snapshotRestore","memberNumber":123}
- 复制束缚: {"type":"copyRestraint","sourceNumber":123,"targetNumber":456}
- 表情: {"type":"emote","memberNumber":123,"expression":"Hearts"}
- BCE 查询: {"type":"bcequery","target":"名字或编号"}
part 可以使用上文列出的语义部位，也可以使用道具清单中的精确 BC group（例如 ItemDevices、ItemHandheld）；没有必要限定部位时留空。精确 group 必须与 item 真实所属 group 一致。
复合操作按真实执行顺序排列 commands。字段不可省略时不要改名，也不要使用旧的 [ITEMADD:...] 文本标签。`;
  }

  function normalizeStructuredCommand(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const aliases = {
      move: "move",
      moveto: "moveTo",
      moveedge: "moveEdge",
      itemadd: "itemadd",
      itemdel: "itemdel",
      itemdelall: "itemdelall",
      itemcolor: "itemcolor",
      itemset: "itemset",
      snapshotsave: "snapshotSave",
      snapshotrestore: "snapshotRestore",
      copyrestraint: "copyRestraint",
      emote: "emote",
      bcequery: "bcequery",
      memsearch: "memsearch",
    };
    const type = aliases[String(raw.type || "").replace(/[_\s-]/g, "").toLowerCase()];
    if (!type) return null;
    const memberNumber = Number(raw.memberNumber);
    const hasMemberNumber = Number.isInteger(memberNumber) && memberNumber > 0;
    const text = key => String(raw[key] || "").trim();
    if (type === "bcequery" && text("target")) return { type, target: text("target") };
    if (type === "memsearch" && text("query")) return { type, query: text("query") };
    if (type === "move" && hasMemberNumber && /^(left|right)$/i.test(text("direction"))) {
      return { type, memberNumber, direction: text("direction").toLowerCase() };
    }
    if (type === "moveTo" && hasMemberNumber &&
        Number.isInteger(Number(raw.targetNumber)) && Number(raw.targetNumber) > 0 &&
        /^(left|right)$/i.test(text("side"))) {
      return {
        type,
        memberNumber,
        targetNumber: Number(raw.targetNumber),
        side: text("side").toLowerCase(),
      };
    }
    if (type === "moveEdge" && hasMemberNumber && /^(left|right)$/i.test(text("edge"))) {
      return { type, memberNumber, edge: text("edge").toLowerCase() };
    }
    if (type === "itemadd" && hasMemberNumber && text("item")) {
      return {
        type,
        memberNumber,
        item: text("item"),
        part: text("part"),
        color: text("color"),
      };
    }
    if (type === "itemdel" && hasMemberNumber && text("item")) {
      return { type, memberNumber, item: text("item"), part: text("part") };
    }
    if (type === "itemdelall" && hasMemberNumber) return { type, memberNumber };
    if (type === "itemcolor" && hasMemberNumber && text("item") && text("color")) {
      return {
        type,
        memberNumber,
        item: text("item"),
        part: text("part"),
        color: text("color"),
      };
    }
    if (type === "itemset" && hasMemberNumber && text("item") &&
        text("property") && text("value")) {
      return {
        type,
        memberNumber,
        item: text("item"),
        part: text("part"),
        property: text("property"),
        value: text("value"),
      };
    }
    if (["snapshotSave", "snapshotRestore"].includes(type) && hasMemberNumber) {
      return { type, memberNumber };
    }
    if (type === "copyRestraint" &&
        Number.isInteger(Number(raw.sourceNumber)) && Number(raw.sourceNumber) > 0 &&
        Number.isInteger(Number(raw.targetNumber)) && Number(raw.targetNumber) > 0) {
      return {
        type,
        sourceNumber: Number(raw.sourceNumber),
        targetNumber: Number(raw.targetNumber),
      };
    }
    if (type === "emote" && hasMemberNumber && text("expression")) {
      return { type, memberNumber, expression: text("expression") };
    }
    return null;
  }

  function parseStructuredReply(reply) {
    const raw = String(reply || "").trim();
    if (!raw) return { matched: false, ok: false, reason: "empty" };
    const unwrapped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    let parsed = null;
    try {
      parsed = JSON.parse(unwrapped);
    } catch (e) {
      const balanced = extractFirstBalancedJsonObject(unwrapped);
      if (balanced) {
        try { parsed = JSON.parse(balanced); } catch (_) {}
      }
      if (!parsed) {
        const completed = completeTruncatedJsonObject(unwrapped);
        if (completed) {
          try { parsed = JSON.parse(completed); } catch (_) {}
        }
      }
    }
    const looksStructured = /^\s*(?:```(?:json)?\s*)?\{/i.test(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { matched: looksStructured, ok: false, reason: "invalid-json" };
    }
    const matched = ["commands", "action", "speech", "protocol"].some(key =>
      Object.prototype.hasOwnProperty.call(parsed, key));
    if (!matched) return { matched: false, ok: false, reason: "not-reply-envelope" };
    const rawCommands = Array.isArray(parsed.commands) ? parsed.commands : [];
    const commands = [];
    const rejectedCommands = [];
    if (!Array.isArray(parsed.commands)) {
      rejectedCommands.push({ reason: "commands-not-array", value: parsed.commands });
    }
    for (const candidate of rawCommands) {
      if (typeof candidate === "string") {
        const legacy = parseActionCommands(candidate);
        if (legacy.commands.length > 0 && !legacy.cleaned) commands.push(...legacy.commands);
        else rejectedCommands.push(candidate);
        continue;
      }
      const normalized = normalizeStructuredCommand(candidate);
      if (normalized) commands.push(normalized);
      else rejectedCommands.push(candidate);
    }
    return {
      matched: true,
      ok: true,
      protocol: String(parsed.protocol || ""),
      commands,
      rejectedCommands,
      action: typeof parsed.action === "string" ? parsed.action : "",
      speech: typeof parsed.speech === "string" ? parsed.speech : "",
    };
  }

  function executeMove(memberNumber, direction) {
    try {
      if (Date.now() - state.lastMoveTime < CONFIG.moveCooldownMs) {
        console.log("[MisakaChat] 移动冷却中");
        return false;
      }
      const char = ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
      if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return false; }
      const action = direction === "left" ? "MoveLeft" : "MoveRight";
      ServerSend("ChatRoomAdmin", { MemberNumber: memberNumber, Action: action, Publish: true });
      state.lastMoveTime = Date.now();
      console.log(`[MisakaChat] 已移动 #${memberNumber} ${direction}`);
      return true;
    } catch(e) {
      console.error("[MisakaChat] 移动失败:", e.message);
      return false;
    }
  }

  // 把 memberNumber 移到 targetNumber 的左边或右边(自动多步)
  async function executeMoveTo(memberNumber, targetNumber, side) {
    try {
      const findIdx = (mn) => ChatRoomCharacter.findIndex(c => c.MemberNumber === mn);
      let srcIdx = findIdx(memberNumber);
      const targetIdx = findIdx(targetNumber);
      if (srcIdx < 0 || targetIdx < 0) {
        console.log(`[MisakaChat] moveTo 找不到玩家 src=${srcIdx} target=${targetIdx}`);
        return false;
      }
      // 目标位置:left = target 的前一位,right = target 的后一位
      let destIdx = side === "left" ? targetIdx : targetIdx + 1;
      // 如果 src 已经在 dest 位置,不需要移动
      // 注意:移走 src 后其他人的 index 会变化,需要逐步移并重新计算
      let steps = 0;
      const maxSteps = 20;  // 安全上限
      while (steps < maxSteps) {
        srcIdx = findIdx(memberNumber);
        const tIdx = findIdx(targetNumber);
        if (srcIdx < 0 || tIdx < 0) break;
        const wantIdx = side === "left" ? tIdx - 1 : tIdx + 1;
        if (srcIdx === wantIdx) break;  // 到位了
        const publish = steps === 0; // 只有第一步推送公屏消息
        if (srcIdx < wantIdx) {
          // 需要往右移
          ServerSend("ChatRoomAdmin", { MemberNumber: memberNumber, Action: "MoveRight", Publish: publish });
        } else {
          // 需要往左移
          ServerSend("ChatRoomAdmin", { MemberNumber: memberNumber, Action: "MoveLeft", Publish: publish });
        }
        steps++;
        // 等待服务器同步
        await new Promise(r => setTimeout(r, 400));
      }
      state.lastMoveTime = Date.now();
      console.log(`[MisakaChat] moveTo #${memberNumber} to #${targetNumber} ${side}, ${steps}步`);
      return steps > 0;
    } catch(e) {
      console.error("[MisakaChat] moveTo 失败:", e.message);
      return false;
    }
  }

  // 把 memberNumber 移到房间最左或最右(循环到头)
  async function executeMoveEdge(memberNumber, edge) {
    try {
      const findIdx = (mn) => ChatRoomCharacter.findIndex(c => c.MemberNumber === mn);
      let steps = 0;
      const maxSteps = 20;
      const lastIdx = () => ChatRoomCharacter.length - 1;
      let lastSrcIdx = -1;
      while (steps < maxSteps) {
        const srcIdx = findIdx(memberNumber);
        if (srcIdx < 0) break;
        if (edge === "left" && srcIdx === 0) break;
        if (edge === "right" && srcIdx === lastIdx()) break;
        // 如果位置没变说明服务器不让再移了(被阻挡)
        if (srcIdx === lastSrcIdx) {
          console.log(`[MisakaChat] moveEdge 卡在 index ${srcIdx},服务器拒绝移动`);
          break;
        }
        lastSrcIdx = srcIdx;
        const action = edge === "left" ? "MoveLeft" : "MoveRight";
        ServerSend("ChatRoomAdmin", { MemberNumber: memberNumber, Action: action, Publish: steps === 0 });
        steps++;
        await new Promise(r => setTimeout(r, 400));
      }
      state.lastMoveTime = Date.now();
      const finalIdx = findIdx(memberNumber);
      const reached = edge === "left" ? finalIdx === 0 : finalIdx === lastIdx();
      console.log(`[MisakaChat] moveEdge #${memberNumber} ${edge}, ${steps}步, 最终 index=${finalIdx}, reached=${reached}`);
      return reached
        ? { ok: true, steps, finalIdx }
        : { ok: false, reason: "move-blocked", steps, finalIdx, edge };
    } catch(e) {
      console.error("[MisakaChat] moveEdge 失败:", e.message);
      return { ok: false, reason: "move-failed" };
    }
  }


  // 部位名 → BC Item group 列表(按优先级)
  const BODY_PART_GROUPS = {
    "Arms": ["ItemArms"],
    "Hands": ["ItemHands"],
    "Legs": ["ItemLegs"],
    "Feet": ["ItemFeet"],
    "Mouth": ["ItemMouth", "ItemMouth2", "ItemMouth3"],
    "Head": ["ItemHead", "ItemHood"],
    "Neck": ["ItemNeck", "ItemNeckRestraints"],
    "Torso": ["ItemTorso", "ItemTorso2"],
    "Pelvis": ["ItemPelvis"],
    "Breast": ["ItemBreast", "ItemNipples", "ItemNipplesPiercings"],
    "Eyes": ["ItemHead"],
    "Ears": ["ItemEars"],
    "Vulva": ["ItemVulva", "ItemVulvaPiercings", "ItemButt", "ItemClit"],
    "Devices": ["ItemDevices"],
  };

  function commandPrimaryTarget(cmd) {
    if (!cmd) return null;
    if (cmd.type === "copyRestraint") return cmd.targetNumber;
    return Number.isFinite(cmd.memberNumber) ? cmd.memberNumber : null;
  }

  function itemCommandResolvedGroups(cmd) {
    if (!cmd || !["itemadd", "itemdel", "itemset"].includes(cmd.type)) return [];
    const target = commandPrimaryTarget(cmd);
    const char = actionTargetCharacter(target);
    if (!char || !cmd.item) return [];
    if (cmd.type === "itemadd") {
      const resolved = resolveItemAddTarget(char, cmd.item, cmd.part);
      return resolved.ok && resolved.group ? [resolved.group] : [];
    }
    const worn = findItemByPart(char, cmd.item, cmd.part);
    if (worn?.Asset?.Group?.Name) return [worn.Asset.Group.Name];
    const resolution = resolveItemPartGroups(char, cmd.item, cmd.part);
    return resolution.ok ? resolution.groups : [];
  }

  // 规划器使用 Arms / Devices 等语义部位，回复协议也允许 ItemArms /
  // ItemDevices 等 BC 原生 group。所有计划边界与 preserveParts 判断都必须先
  // 归一到经 AssetGet 验证的真实 group，不能再直接比较字符串。
  function itemCommandTouchesPlannedParts(cmd, plannedParts) {
    const parts = Array.isArray(plannedParts) ? plannedParts.filter(Boolean) : [];
    if (parts.length === 0) return false;
    const rawPart = String(cmd?.part || "").trim();
    if (rawPart && parts.includes(rawPart)) return true;
    const actualGroups = itemCommandResolvedGroups(cmd);
    if (actualGroups.length === 0) return false;
    return parts.some(part => {
      const plannedGroups = BODY_PART_GROUPS[part] ||
        (/^Item[A-Za-z0-9]+$/.test(part) ? [part] : []);
      return plannedGroups.some(group => actualGroups.includes(group));
    });
  }

  function commandMatchesPlannedOperation(cmd, operation) {
    if (!cmd || !operation) return false;
    const types = Array.isArray(operation.types) ? operation.types : [];
    if (!types.includes(cmd.type)) return false;
    const targets = (Array.isArray(operation.targets) ? operation.targets : []).map(Number);
    const target = commandPrimaryTarget(cmd);
    if (targets.length > 0 && target !== null && !targets.includes(target)) return false;
    const parts = Array.isArray(operation.parts) ? operation.parts : [];
    if (parts.length > 0 && ["itemadd", "itemdel", "itemset"].includes(cmd.type)) {
      if (!itemCommandTouchesPlannedParts(cmd, parts)) return false;
    }
    // assets 是规划器已从权威目录解析出的精确目标道具。添加、设置与改色
    // 必须命中它；替换时的 ITEMDEL 仍允许删除当前旧道具。
    const assets = (Array.isArray(operation.assets) ? operation.assets : [])
      .map(name => String(name).toLowerCase());
    if (assets.length > 0 && ["itemadd", "itemset", "itemcolor"].includes(cmd.type)) {
      const mapping = findItemAsset(cmd.item, actionTargetCharacter(target));
      const actualAsset = String(mapping?.asset || cmd.item || "").toLowerCase();
      if (!assets.includes(actualAsset)) return false;
    }
    return true;
  }

  function commandFamily(type) {
    if (["itemadd", "itemdel", "itemset", "itemcolor"].includes(type)) return "item";
    if (["move", "moveTo", "moveEdge"].includes(type)) return "move";
    return type || "";
  }

  // 规划器只负责圈定“要操作谁、操作哪一大类、有哪些明确限制”。
  // 具体使用 ADD/SET/DEL、哪个 Asset 与哪个 BC group 由看到完整目录的主模型决定。
  // 这样规划器漏列某个细分类型、部位或别名时，不会驳回本来可执行的正确指令。
  function commandWithinLoosePlanBoundary(cmd, operation) {
    if (!cmd || !operation) return false;
    const targets = (Array.isArray(operation.targets) ? operation.targets : []).map(Number);
    const target = commandPrimaryTarget(cmd);
    if (targets.length > 0 && target !== null && !targets.includes(target)) return false;
    const types = Array.isArray(operation.types) ? operation.types : [];
    // 解除全部、恢复快照和复制束缚影响面较大，仍须由规划器明确列出。
    if (["itemdelall", "snapshotRestore", "copyRestraint"].includes(cmd.type)) {
      return types.includes(cmd.type);
    }
    const family = commandFamily(cmd.type);
    return types.some(type => commandFamily(type) === family);
  }

  function canonicalizeUnscopedExactAssetPart(cmd, operations) {
    if (!cmd?.part || !["itemadd", "itemdel", "itemset"].includes(cmd.type)) return cmd;
    const target = commandPrimaryTarget(cmd);
    const operation = (operations || []).find(candidate => {
      if (!commandWithinLoosePlanBoundary(cmd, candidate) || candidate?.parts?.length) return false;
      const assets = (candidate.assets || []).map(asset => String(asset).toLowerCase());
      const mapping = findItemAsset(cmd.item, actionTargetCharacter(target));
      const actualAsset = String(mapping?.asset || cmd.item || "").toLowerCase();
      return assets.length > 0 && assets.includes(actualAsset);
    });
    if (!operation) return cmd;
    const char = actionTargetCharacter(target);
    const mapping = findItemAsset(cmd.item, char);
    if (!char || !mapping) return cmd;
    const requested = resolveItemPartGroups(char, cmd.item, cmd.part);
    if (requested.ok) return cmd;
    // 用户没有限定部位、规划器已锁定精确 Asset，模型却给出与该 Asset
    // 不兼容的语义部位时，以权威 Asset 默认 group 收口。这里不处理用户明确
    // 指定部位的计划，避免把“戴到手上”悄悄改成别的身体部位。
    return { ...cmd, part: mapping.group };
  }

  function canonicalizeExactAssetPartToPlan(cmd, operations) {
    if (!cmd?.item || !["itemadd", "itemdel", "itemset"].includes(cmd.type)) return cmd;
    const target = commandPrimaryTarget(cmd);
    const char = actionTargetCharacter(target);
    const mapping = findItemAsset(cmd.item, char);
    if (!char || !mapping) return cmd;
    const operation = (operations || []).find(candidate => {
      if (!commandWithinLoosePlanBoundary(cmd, candidate) || candidate?.parts?.length !== 1) return false;
      const assets = (candidate.assets || []).map(asset => String(asset).toLowerCase());
      return assets.length > 0 && assets.includes(String(mapping.asset).toLowerCase());
    });
    if (!operation) return cmd;
    const plannedPart = String(operation.parts[0] || "").trim();
    const plannedGroups = BODY_PART_GROUPS[plannedPart] ||
      (/^Item[A-Za-z0-9]+$/.test(plannedPart) ? [plannedPart] : []);
    if (plannedGroups.length !== 1 ||
        !AssetGet(char.AssetFamily, plannedGroups[0], mapping.asset)) return cmd;
    const actualGroups = itemCommandResolvedGroups(cmd);
    if (actualGroups.length === 1 && actualGroups[0] === plannedGroups[0]) return cmd;
    // 只有“目标、精确 Asset、唯一原生 group”均已由确定性目录锁定时才纠正。
    // 这覆盖“放到手里却生成 ItemMouth”，不会把模糊身体部位静默改写。
    return { ...cmd, part: plannedGroups[0] };
  }

  // 宽松审查：只拦截跨对象、跨操作大类、明确禁止项与高影响未授权操作。
  // Asset、部位和 ADD/SET/DEL 细分不再要求与规划器逐字匹配。
  function filterCommandsByPlan(plan, commands) {
    const operations = Array.isArray(plan?.operations) ? plan.operations : [];
    const executable = commands
      .filter(c => !["memsearch", "bcequery"].includes(c.type))
      .map(command => canonicalizeUnscopedExactAssetPart({ ...command }, operations))
      .map(command => canonicalizeExactAssetPartToPlan(command, operations));
    if (!plan || plan.intent !== "action") {
      return { allowed: [], rejected: executable.map(cmd => ({ cmd, reason: "not-an-action-plan" })) };
    }
    const constraints = plan.constraints || {};
    const allowed = [], rejected = [];
    for (const cmd of executable) {
      let reason = "";
      if (!operations.some(op => commandWithinLoosePlanBoundary(cmd, op))) reason = "outside-plan-boundary";
      else if (constraints.noMove && ["move", "moveTo", "moveEdge"].includes(cmd.type)) reason = "movement-forbidden";
      else if (constraints.noAdd && cmd.type === "itemadd") reason = "adding-forbidden";
      else if (["itemadd", "itemdel", "itemset"].includes(cmd.type) &&
          itemCommandTouchesPlannedParts(cmd, constraints.preserveParts)) {
        reason = "part-must-be-preserved";
      } else if (cmd.type === "itemcolor" &&
          (constraints.preserveParts || []).includes(cmd.part)) {
        reason = "part-must-be-preserved";
      }
      if (reason) rejected.push({ cmd, reason });
      else allowed.push(cmd);
    }
    return { allowed, rejected };
  }

  function plannedPartForAsset(operation, mapping) {
    if (operation?.parts?.length) return operation.parts[0];
    if (!mapping?.group) return "";
    return Object.keys(BODY_PART_GROUPS).find(part =>
      (BODY_PART_GROUPS[part] || []).includes(mapping.group)) || "";
  }

  // 精确替换计划已经包含目标、旧 Asset 与新 Asset 时，不必让聊天模型再次
  // 猜指令。仅在能生成一组完整且通过同一安全过滤器的 DEL -> ADD 序列时启用。
  function buildDeterministicExactReplacementReply(plan) {
    if (plan?.intent !== "action" || !plan?.constraints?.replaceExisting) return "";
    const deletes = [], adds = [];
    const seen = new Set();
    for (const operation of plan.operations || []) {
      if (!Array.isArray(operation.assets) || operation.assets.length === 0) continue;
      for (const target of operation.targets || []) {
        const char = actionTargetCharacter(Number(target));
        if (!char) continue;
        for (const assetName of operation.assets) {
          const mapping = findItemAsset(assetName, char);
          if (!mapping) continue;
          const part = plannedPartForAsset(operation, mapping);
          const worn = (char.Appearance || []).some(a =>
            a?.Asset?.Name === mapping.asset && a?.Asset?.Group?.Name === mapping.group);
          if (operation.types?.includes("itemdel") && worn) {
            const key = `del:${target}:${mapping.asset}:${part}`;
            if (!seen.has(key)) {
              seen.add(key);
              deletes.push({ type: "itemdel", memberNumber: Number(target), item: mapping.asset, part });
            }
          }
          if (operation.types?.includes("itemadd")) {
            const key = `add:${target}:${mapping.asset}:${part}`;
            if (!seen.has(key)) {
              seen.add(key);
              adds.push({ type: "itemadd", memberNumber: Number(target), item: mapping.asset, part, color: "" });
            }
          }
        }
      }
    }
    if (deletes.length === 0 || adds.length === 0) return "";
    const commands = [...deletes, ...adds];
    const filtered = filterCommandsByPlan(plan, commands);
    if (filtered.allowed.length !== commands.length || filtered.rejected.length > 0) return "";
    return JSON.stringify({
      protocol: STRUCTURED_REPLY_PROTOCOL,
      commands,
      action: "",
      speech: "好了。",
    });
  }

  // 供浏览器现场回归读取；不暴露密钥或底层执行函数。
  window.__misakaPlanDebug = {
    filterCommandsByPlan,
    parseActionCommands,
    parseStructuredReply,
    parseAssistantReply,
    dryRunStructuredReplyForTest,
    dryRunEmptyContentRecoveryForTest,
    dryRunCallBurstForTest,
    buildDeterministicExactReplacementReply,
    normalizeReplacementPlanOperations,
    stripQuotedSegmentsForTest: stripQuotedSegments,
    recentConversationHasAnswerForTest: recentConversationHasAnswer,
    normalizePlannerMemoryDecisionForTest: (plan, content, senderNum) =>
      normalizePlannerMemoryDecision(
        JSON.parse(JSON.stringify(plan || {})), content, senderNum),
    normalizeAssistantIdentityForTest: (reply, content) =>
      normalizeAssistantIdentity(reply, content),
    normalizePlannerActivityDecisionForTest: (plan, content, senderNum) =>
      normalizePlannerActivityDecision(
        JSON.parse(JSON.stringify(plan || {})), content, senderNum),
    normalizePlannerQuotedReportDecisionForTest: (plan, content) =>
      normalizePlannerQuotedReportDecision(
        JSON.parse(JSON.stringify(plan || {})), content),
    normalizePlannerAmbiguousSingleItemDecisionForTest: (plan, content) =>
      normalizePlannerAmbiguousSingleItemDecision(
        JSON.parse(JSON.stringify(plan || {})), content),
    normalizePlannerSimpleRoleplayDecisionForTest: (plan, content) =>
      normalizePlannerSimpleRoleplayDecision(
        JSON.parse(JSON.stringify(plan || {})), content),
    buildPlannerRecentContextForTest: buildPlannerRecentContext,
    normalizePlannerOperationsForTest: rawOperations => normalizePlannerOperations(
      rawOperations,
      new Set((ChatRoomCharacter || []).map(c => Number(c.MemberNumber)).concat(Number(Player?.MemberNumber))),
      new Set(["itemadd","itemdel","itemdelall","itemset","itemcolor","move","moveTo","moveEdge","snapshotSave","snapshotRestore","copyRestraint","emote"]),
      new Set(["Arms","Hands","Legs","Feet","Mouth","Head","Neck","Torso","Pelvis","Breast","Eyes","Ears","Vulva","Devices"]),
    ),
    enrichPlannerAssetsFromExplicitMentionsForTest: (plan, content) =>
      enrichPlannerAssetsFromExplicitMentions(plan, content),
    normalizePlannerExplicitActionTargetsForTest: (plan, content) =>
      normalizePlannerExplicitActionTargets(plan, content),
    findUniqueMentionedRoomCharacterForTest: content => {
      const character = findUniqueMentionedRoomCharacter(content);
      return character ? {
        memberNumber: Number(character.MemberNumber),
        name: character.Nickname || character.Name,
      } : null;
    },
    beginsWithMisakaInvocationForTest: beginsWithMisakaInvocation,
    foldIdentityTextForTest: foldIdentityText,
    normalizePlannerHandheldGiveDecisionForTest: (plan, content, senderNum) =>
      normalizePlannerHandheldGiveDecision(JSON.parse(JSON.stringify(plan || {})), content, senderNum),
    normalizePlannerExpiredHandheldReplacementForTest: (plan, content) =>
      normalizePlannerExpiredHandheldReplacement(JSON.parse(JSON.stringify(plan || {})), content),
    normalizePlannerExplicitItemAddDecisionForTest: (plan, content) =>
      normalizePlannerExplicitItemAddDecision(JSON.parse(JSON.stringify(plan || {})), content),
    normalizePlannerColloquialItemAliasesForTest: (plan, content) =>
      normalizePlannerColloquialItemAliases(JSON.parse(JSON.stringify(plan || {})), content),
    normalizePlannerBroadDestructiveDecisionForTest: (plan, content) =>
      normalizePlannerBroadDestructiveDecision(JSON.parse(JSON.stringify(plan || {})), content),
    recoverExplicitCurrentItemOperationForTest: (plan, content) =>
      recoverExplicitCurrentItemOperation(plan, content),
    snapshotRecentMessagesForTest: () => state.recentMessages.map(message => ({ ...message })),
    replaceRecentMessagesForTest: messages => {
      state.recentMessages = (Array.isArray(messages) ? messages : []).map(message => ({ ...message }));
    },
    inspectLifecycleForTest: () => ({
      id: lifecycle.id,
      mode: lifecycle.mode,
      current: isCurrent(),
      disposed: lifecycle.disposed,
      timeouts: lifecycle.timeouts.size,
      intervals: lifecycle.intervals.size,
      requests: lifecycle.requests.size,
      idbReady: state.idbReady,
      refinedIdbReady: state.refinedIdbReady,
      semanticMemories: state.semanticMemories.length,
      refinedMemories: state.refinedMemories.length,
    }),
    inspectEmbeddingConfigForTest: () => CONFIG.embeddingProviders.map(provider => ({
      name: provider.name,
      base: provider.base,
      model: provider.model,
      keyNames: [...provider.keyNames],
      dimensions: provider.dimensions,
    })),
    // 只读现场回归入口：复用真实规划、检索与回答链，不暴露密钥或执行函数。
    planUserRequest,
    buildPlannerMemoryQuery,
    buildMemoryEvidence,
    answerMemoryQuestion,
  };

  function buildCurrentAppearanceFacts(plan) {
    const targets = [...new Set((plan?.operations || []).flatMap(op => op.targets || []).map(Number))];
    if (targets.length === 0) return "";
    const lines = [];
    for (const mn of targets) {
      const char = mn === Player?.MemberNumber ? Player : (ChatRoomCharacter || []).find(c => Number(c.MemberNumber) === mn);
      if (!char) continue;
      const name = char.Nickname || char.Name || `#${mn}`;
      const items = (char.Appearance || []).filter(a => a?.Asset?.Group?.Name?.startsWith("Item")).map(a => {
        const prop = a.Property || {};
        const stateBits = [];
        if (prop.Type !== undefined) stateBits.push(`Type=${prop.Type}`);
        if (prop.TypeRecord && Object.keys(prop.TypeRecord).length) stateBits.push(`TypeRecord=${JSON.stringify(prop.TypeRecord)}`);
        if (prop.LockedBy) stateBits.push(`LockedBy=${prop.LockedBy}`);
        return `${a.Asset.Description || a.Asset.Name}(${a.Asset.Name})@${a.Asset.Group.Name}${stateBits.length ? `{${stateBits.join(",")}}` : ""}`;
      });
      lines.push(`${name}#${mn}: ${items.length ? items.join("；") : "当前没有任何 Item 道具"}`);
    }
    return lines.length ? `【当前实时 Appearance（权威事实，优先于历史消息）】\n${lines.join("\n")}\n若这里没有某道具，就不得声称它当前存在或直接修改它。` : "";
  }

  function actionTargetCharacter(memberNumber) {
    return Number(memberNumber) === Number(Player?.MemberNumber)
      ? Player
      : (ChatRoomCharacter || []).find(c => Number(c.MemberNumber) === Number(memberNumber));
  }

  function strictCommandItem(char, itemName, part) {
    if (!char) return null;
    const resolution = resolveItemPartGroups(char, itemName, part);
    if (!resolution.ok) return null;
    const assetName = resolution.asset;
    const groups = resolution.groups;
    const candidates = (char.Appearance || []).filter(a => a?.Asset?.Group?.Name?.startsWith("Item"));
    const scoped = groups.length ? candidates.filter(a => groups.includes(a.Asset.Group.Name)) : candidates;
    return scoped.find(a =>
      a?.Asset?.Name === assetName ||
      a?.Asset?.Name === itemName ||
      a?.Asset?.Description === itemName
    ) || null;
  }

  function typedOptionState(item) {
    try {
      const data = TypedItemDataLookup[item.Asset.Group.Name + item.Asset.Name];
      const record = item.Property?.TypeRecord || {};
      const index = Number(record.typed ?? Object.values(record)[0]);
      const option = data?.options?.[index];
      if (!option) return null;
      return {
        name: String(option.Name || ""),
        index,
        setPose: option.Property?.SetPose || item.Property?.SetPose || [],
        effect: option.Property?.Effect || item.Property?.Effect || [],
      };
    } catch(e) { return null; }
  }

  function postconditionKey(cmd) {
    const mapping = findItemAsset(cmd.item, actionTargetCharacter(cmd.memberNumber));
    return `${Number(cmd.memberNumber)}:${mapping?.asset || cmd.item}:${cmd.part || mapping?.group || "*"}`;
  }

  function buildCommandPostconditions(commands) {
    const finalItems = new Map();
    const delAllTargets = new Set();
    for (const cmd of commands || []) {
      if (cmd.type === "itemdelall") {
        delAllTargets.add(Number(cmd.memberNumber));
        for (const [key, value] of finalItems) {
          if (value.memberNumber === Number(cmd.memberNumber)) finalItems.delete(key);
        }
        continue;
      }
      if (!["itemadd", "itemdel", "itemset", "itemcolor"].includes(cmd.type)) continue;
      const key = postconditionKey(cmd);
      let expected = finalItems.get(key) || {
        memberNumber: Number(cmd.memberNumber), item: cmd.item, part: cmd.part || "",
        exists: true, properties: [], color: null,
      };
      if (cmd.type === "itemdel") {
        expected = { ...expected, exists: false, properties: [], color: null };
      } else if (cmd.type === "itemadd") {
        expected = { ...expected, exists: true, properties: [], color: cmd.color || null };
      } else if (cmd.type === "itemset") {
        expected.exists = true;
        expected.properties = expected.properties.filter(p => p.property !== cmd.property);
        expected.properties.push({ property: cmd.property, value: cmd.value });
      } else if (cmd.type === "itemcolor") {
        expected.exists = true;
        expected.color = { value: cmd.color, layer: BODY_PART_GROUPS[cmd.part] ? "" : (cmd.part || "") };
      }
      finalItems.set(key, expected);
    }
    return { items: [...finalItems.values()], delAllTargets: [...delAllTargets] };
  }

  function verifyPropertyPostcondition(item, expected) {
    const archetype = item?.Asset?.Archetype;
    const requested = String(expected.value || "");
    if (archetype === "typed") {
      const expectedName = findTypedOptionName(item, requested);
      const actual = typedOptionState(item);
      return expectedName && actual?.name?.toLowerCase() === expectedName.toLowerCase()
        ? { ok: true, actual }
        : { ok: false, reason: `样式应为 ${expectedName || requested}，实际为 ${actual?.name || "未知"}` };
    }
    if (archetype === "modular") {
      const match = findModularOption(item.Asset, expected.property, requested);
      const actualIndex = item.Property?.TypeRecord?.[expected.property];
      return match && Number(actualIndex) === Number(match.index)
        ? { ok: true, actual: { module: expected.property, index: actualIndex } }
        : { ok: false, reason: `模块 ${expected.property} 未达到 ${requested}` };
    }
    if (archetype === "vibrating") {
      const opt = VIBRATOR_OPTIONS.find(o => o.name.toLowerCase() === requested.toLowerCase());
      return opt && item.Property?.Mode === opt.mode && Number(item.Property?.Intensity) === Number(opt.intensity)
        ? { ok: true, actual: { mode: item.Property.Mode, intensity: item.Property.Intensity } }
        : { ok: false, reason: `震动状态未达到 ${requested}` };
    }
    const fallback = PROPERTY_MAP[expected.property];
    const key = fallback?.type === "direct" ? fallback.key : expected.property;
    const wanted = fallback?.values && Object.prototype.hasOwnProperty.call(fallback.values, requested)
      ? fallback.values[requested]
      : expected.value;
    return JSON.stringify(item.Property?.[key]) === JSON.stringify(wanted)
      ? { ok: true, actual: { [key]: item.Property?.[key] } }
      : { ok: false, reason: `属性 ${key} 未达到 ${requested}` };
  }

  function verifyColorPostcondition(item, expected) {
    const wanted = colorNameToHex(typeof expected === "string" ? expected : expected?.value);
    if (!wanted) return { ok: false, reason: "无法解析期望颜色" };
    const layer = typeof expected === "object" ? expected.layer : "";
    const colors = Array.isArray(item.Color) ? item.Color : [];
    if (layer) {
      const index = findLayerIndex(item.Asset, layer);
      return index !== undefined && colors[index] === wanted
        ? { ok: true, actual: { layer, color: colors[index] } }
        : { ok: false, reason: `部件 ${layer} 颜色未达到 ${wanted}` };
    }
    return colors.length > 0 && colors.every(c => c === wanted)
      ? { ok: true, actual: { colors } }
      : { ok: false, reason: `颜色未全部达到 ${wanted}` };
  }

  function verifyCommandPostconditions(commands) {
    const expected = buildCommandPostconditions(commands);
    const checks = [];
    for (const itemExpected of expected.items) {
      const char = actionTargetCharacter(itemExpected.memberNumber);
      if (!char) { checks.push({ ok: false, expected: itemExpected, reason: "目标人物不存在" }); continue; }
      const item = strictCommandItem(char, itemExpected.item, itemExpected.part);
      if (!itemExpected.exists) {
        checks.push(item ? { ok: false, expected: itemExpected, reason: "要求删除的道具仍然存在" } : { ok: true, expected: itemExpected });
        continue;
      }
      if (!item) { checks.push({ ok: false, expected: itemExpected, reason: "要求保留的道具不存在" }); continue; }
      let ok = true;
      const actual = { asset: item.Asset.Name, group: item.Asset.Group.Name };
      for (const prop of itemExpected.properties) {
        const result = verifyPropertyPostcondition(item, prop);
        if (!result.ok) { checks.push({ ok: false, expected: itemExpected, reason: result.reason }); ok = false; break; }
        actual[prop.property] = result.actual;
      }
      if (ok && itemExpected.color) {
        const result = verifyColorPostcondition(item, itemExpected.color);
        if (!result.ok) { checks.push({ ok: false, expected: itemExpected, reason: result.reason }); ok = false; }
        else actual.color = result.actual;
      }
      if (ok) checks.push({ ok: true, expected: itemExpected, actual });
    }
    for (const memberNumber of expected.delAllTargets) {
      const char = actionTargetCharacter(memberNumber);
      const remaining = (char?.Appearance || []).filter(a => a?.Asset?.Group?.Name?.startsWith("Item") && !a.Property?.LockedBy);
      checks.push(remaining.length === 0
        ? { ok: true, expected: { memberNumber, allUnlockedItemsAbsent: true } }
        : { ok: false, expected: { memberNumber, allUnlockedItemsAbsent: true }, reason: `仍有 ${remaining.length} 件未锁道具` });
    }
    const failed = checks.find(c => !c.ok);
    return { satisfied: !failed, reason: failed?.reason || "所有确定性后置条件均满足", checks };
  }

  function captureActionBaseline(plan) {
    const targets = [...new Set((plan?.operations || []).flatMap(op => op.targets || []).map(Number))];
    const characters = {};
    for (const memberNumber of targets) {
      const char = actionTargetCharacter(memberNumber);
      if (!char) continue;
      const groups = {};
      for (const item of (char.Appearance || []).filter(a => a?.Asset?.Group?.Name?.startsWith("Item"))) {
        groups[item.Asset.Group.Name] = stableItemSignature(item);
      }
      characters[memberNumber] = { groups, roomIndex: (ChatRoomCharacter || []).findIndex(c => Number(c.MemberNumber) === memberNumber) };
    }
    return {
      characters,
      roomOrder: (ChatRoomCharacter || []).map(c => Number(c.MemberNumber)),
    };
  }

  async function restoreRoomPositions(baseline, memberNumbers) {
    const originalOrder = Array.isArray(baseline?.roomOrder) ? baseline.roomOrder : [];
    const targets = [...new Set((memberNumbers || []).map(Number).filter(Number.isFinite))]
      .filter(mn => originalOrder.includes(mn));
    if (targets.length === 0) return { ok: true, restored: [] };
    const restored = [];
    // 多个目标会互相影响 index，因此最多做三轮收敛；每次都读取服务器同步后的
    // ChatRoomCharacter 实时顺序，不盲算本地位置。
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const memberNumber of targets) {
        const wanted = originalOrder.indexOf(memberNumber);
        let current = (ChatRoomCharacter || []).findIndex(c => Number(c.MemberNumber) === memberNumber);
        let steps = 0;
        while (current >= 0 && current !== wanted && steps < 20) {
          const action = current < wanted ? "MoveRight" : "MoveLeft";
          ServerSend("ChatRoomAdmin", { MemberNumber: memberNumber, Action: action, Publish: false });
          await new Promise(r => setTimeout(r, 400));
          const next = (ChatRoomCharacter || []).findIndex(c => Number(c.MemberNumber) === memberNumber);
          if (next === current) break;
          current = next;
          steps++;
          changed = true;
        }
        if (current === wanted && !restored.includes(memberNumber)) restored.push(memberNumber);
      }
      if (!changed || targets.every(mn =>
        (ChatRoomCharacter || []).findIndex(c => Number(c.MemberNumber) === mn) === originalOrder.indexOf(mn)
      )) break;
    }
    const failed = targets.filter(mn =>
      (ChatRoomCharacter || []).findIndex(c => Number(c.MemberNumber) === mn) !== originalOrder.indexOf(mn)
    );
    if (targets.length > 0) state.lastMoveTime = Date.now();
    return { ok: failed.length === 0, restored, failed };
  }

  function restoreAppearanceBackups(backups) {
    const restored = [];
    for (const [mn, backup] of backups || []) {
      const char = Number(mn) === Number(Player?.MemberNumber)
        ? Player
        : (ChatRoomCharacter || []).find(c => Number(c.MemberNumber) === Number(mn));
      if (!char) continue;
      CharacterAppearanceRestore(char, backup);
      updateCharacter(char);
      restored.push(Number(mn));
    }
    return restored;
  }

  async function rollbackActionState(baseline, appearanceBackups, movementTargets) {
    const appearance = restoreAppearanceBackups(appearanceBackups);
    const positions = await restoreRoomPositions(baseline, movementTargets);
    return { appearance, positions, ok: positions.ok };
  }

  function stableItemSignature(item) {
    const property = JSON.parse(JSON.stringify(item?.Property || {}));
    // 这些字段会随客户端动画/计时器变化，不代表用户可见配置被修改。
    delete property.BlinkState;
    delete property.NextShockTime;
    return JSON.stringify({ asset: item?.Asset?.Name || "", color: item?.Color || [], property });
  }

  function signatureAsset(signature) {
    try { return JSON.parse(signature || "{}").asset || ""; } catch(e) { return ""; }
  }

  function verifyPlanConstraints(plan, baseline) {
    const constraints = plan?.constraints || {};
    const checks = [];
    for (const [rawMemberNumber, before] of Object.entries(baseline?.characters || {})) {
      const memberNumber = Number(rawMemberNumber);
      const char = actionTargetCharacter(memberNumber);
      if (!char) { checks.push({ ok: false, reason: `目标 #${memberNumber} 已离开` }); continue; }
      const afterGroups = {};
      for (const item of (char.Appearance || []).filter(a => a?.Asset?.Group?.Name?.startsWith("Item"))) {
        afterGroups[item.Asset.Group.Name] = stableItemSignature(item);
      }
      if (constraints.noMove) {
        const afterIndex = (ChatRoomCharacter || []).findIndex(c => Number(c.MemberNumber) === memberNumber);
        checks.push(afterIndex === before.roomIndex ? { ok: true, constraint: "noMove" } : { ok: false, constraint: "noMove", reason: "人物位置发生变化" });
      }
      if (constraints.noAdd) {
        const added = Object.keys(afterGroups).filter(group =>
          !(group in before.groups) || signatureAsset(afterGroups[group]) !== signatureAsset(before.groups[group])
        );
        checks.push(added.length === 0 ? { ok: true, constraint: "noAdd" } : { ok: false, constraint: "noAdd", reason: `新增了 ${added.join(",")}` });
      }
      if (constraints.noStack) {
        const plannedParts = [...new Set((plan.operations || []).flatMap(op =>
          (op.targets || []).map(Number).includes(memberNumber) ? (op.parts || []) : []
        ))];
        for (const part of plannedParts) {
          const groups = BODY_PART_GROUPS[part] || [];
          const afterCount = groups.filter(group => group in afterGroups).length;
          checks.push(afterCount <= 1
            ? { ok: true, constraint: `noStack:${part}` }
            : { ok: false, constraint: `noStack:${part}`, reason: `${part} 叠加了 ${afterCount} 件道具` });
        }
      }
      for (const part of constraints.preserveParts || []) {
        const groups = BODY_PART_GROUPS[part] || [];
        const changed = groups.filter(group => (before.groups[group] || null) !== (afterGroups[group] || null));
        checks.push(changed.length === 0 ? { ok: true, constraint: `preserve:${part}` } : { ok: false, constraint: `preserve:${part}`, reason: `${part} 被改动` });
      }
    }
    const failed = checks.find(c => !c.ok);
    return { satisfied: !failed, reason: failed?.reason || "所有明确限制均满足", checks };
  }

  function verifiedEffectSummary(postconditionResult) {
    return (postconditionResult?.checks || []).filter(c => c.ok).map(c => ({ expected: c.expected, actual: c.actual || null }));
  }

  async function verifyActionOutcome(plan, commands, baseline) {
    if (!Array.isArray(commands) || commands.length === 0) return { satisfied: null, reason: "no-commands" };
    const postconditions = verifyCommandPostconditions(commands);
    if (!postconditions.satisfied) return { satisfied: false, reason: postconditions.reason, postconditions };
    const constraints = verifyPlanConstraints(plan, baseline);
    if (!constraints.satisfied) return { satisfied: false, reason: constraints.reason, postconditions, constraints };
    const effects = verifiedEffectSummary(postconditions);
    // 不再调用第二个 LLM 审查“这算不算实现了用户语义”。主模型负责理解意图，
    // 执行后只核对客观事实：指令是否生效、最终状态是否正确、用户明确限制是否违反。
    return {
      satisfied: true,
      reason: "确定性后置条件与明确限制均满足",
      semanticReview: null,
      postconditions,
      constraints,
      effects,
    };
  }

  Object.assign(window.__misakaPlanDebug, {
    buildCommandPostconditions,
    verifyCommandPostconditions,
    captureActionBaseline,
    verifyPlanConstraints,
    normalizeRoleplayReply,
    normalizeVisibleReplyForTest: normalizeVisibleReply,
    formatStructuredVisibleReplyForTest: formatStructuredVisibleReply,
    parseStructuredReplyForTest: parseStructuredReply,
    parseAssistantReplyForTest: parseAssistantReply,
    dryRunPlannedRequestForTest,
    dryRunConversationForTest,
    resolveItemAddTargetForTest: (itemName, part, memberNumber) => {
      const char = actionTargetCharacter(memberNumber);
      const resolved = resolveItemAddTarget(char, itemName, part);
      if (!resolved.ok) return resolved;
      return {
        ok: true,
        group: resolved.group,
        asset: resolved.asset,
        partKind: resolved.partKind,
      };
    },
    inspectAllowedActivities: memberNumber => buildAllowedActivityCatalog(memberNumber).map(candidate => ({
      key: activityCandidateKey(candidate),
      activityName: candidate.activityName,
      groupName: candidate.groupName,
      itemAsset: candidate.itemAsset,
      itemGroup: candidate.itemGroup,
      label: candidate.label,
    })),
    resolvePlannedActivity,
    dryRunNativeActivity: selection => executeNativeActivity(selection, { dryRun: true }),
    shouldFallbackActivityToRoleplay,
    inspectStickerCatalog: getStickerCatalog,
    inspectStickerCooldown: stickerCooldownStatus,
    dryRunSticker: stickerId => sendSticker(stickerId, { dryRun: true }),
    inspectFriendEligibility: friendRelationshipStatus,
    inspectFriendEvidence: buildAutoFriendEvidence,
    inspectFriendAudit: loadFriendAudit,
    classifyFriendEvidence,
    dryRunNativeFriend: memberNumber => addNativeFriend(
      memberNumber,
      { mode: "test", reason: "dry-run", evidence: [] },
      { dryRun: true, ignoreFeatureSwitch: true, ignoreRateLimit: true },
    ),
    inspectCapabilityTrace: () => {
      try {
        const parsed = JSON.parse(localStorage.getItem(storageKey("capability_trace")) || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    },
  });

  function findItemByPart(char, itemName, part) {
    if (!char) return null;
    const resolution = resolveItemPartGroups(char, itemName, part);
    if (!resolution.ok) return null;
    return (char.Appearance || []).find(a =>
      resolution.groups.includes(a?.Asset?.Group?.Name) &&
      (a?.Asset?.Name === resolution.asset ||
       a?.Asset?.Name === itemName ||
       a?.Asset?.Description === itemName)
    ) || null;
  }


  function assetCnName(asset) {
    return (typeof MisakaPersona !== "undefined" && MisakaPersona.assetCnName) ? MisakaPersona.assetCnName(asset) : (asset?.Description || asset?.Name || "");
  }

  function findItemAsset(itemName, targetChar) {
    if (!itemName) return null;
    if (typeof Asset === "undefined" || !Array.isArray(Asset)) return null;
    const rawName = String(itemName).trim();
    if (!rawName) return null;

    // 检查角色身上穿着的道具（优先 targetChar，再查 Player）
    const checkWorn = (a) => {
      const chars = [];
      if (targetChar && targetChar !== Player) chars.push(targetChar);
      chars.push(Player);
      return chars.some(ch => ch.Appearance.some(ap => ap.Asset?.Name === a.Name && ap.Asset?.Group?.Name === a.Group?.Name));
    };

    // 精确匹配英文名（可能有多个同名 asset 在不同 group，优先选穿着的）
    const candidates = Asset.filter(a => a?.Group?.Name?.startsWith("Item") && a.Name === rawName);
    if (candidates.length > 0) {
      const worn = candidates.find(a => checkWorn(a));
      const exact = worn || candidates[0];
      return { group: exact.Group.Name, asset: exact.Name };
    }

    // 去空格模糊匹配（LLM 可能输出 "Ribbon Corset" 但 BC 里是 "RibbonCorset"）
    const noSpace = rawName.replace(/\s+/g, "");
    const fuzzyCandidates = Asset.filter(a => a?.Group?.Name?.startsWith("Item") && (a.Name === noSpace || a.Name.replace(/\s+/g, "") === noSpace));
    if (fuzzyCandidates.length > 0) {
      const worn = fuzzyCandidates.find(a => checkWorn(a));
      const fuzzy = worn || fuzzyCandidates[0];
      return { group: fuzzy.Group.Name, asset: fuzzy.Name };
    }

    // 中文/描述匹配(按优先级分组)
    const priorityGroups = [
      "ItemMouth","ItemMouth2","ItemMouth3","ItemHead","ItemHood","ItemEars",
      "ItemNeck","ItemNeckAccessories","ItemArms","ItemHands","ItemFeet",
      "ItemLegs","ItemBoots","ItemTorso","ItemTorso2","ItemPelvis",
      "ItemBreast","ItemNipples","ItemNipplesPiercings","ItemVulva",
      "ItemVulvaPiercings","ItemButt","ItemDevices","ItemClit",
      "ItemHandheld","ItemScript","ItemAddon","ItemMisc","ItemNeckRestraints"
    ];
    for (const g of priorityGroups) {
      for (const a of Asset) {
        if (a?.Group?.Name !== g) continue;
        const cn = assetCnName(a);
        if (a.Description === rawName || cn === rawName) return { group: g, asset: a.Name };
      }
    }
    // 包含匹配
    for (const g of priorityGroups) {
      for (const a of Asset) {
        if (a?.Group?.Name !== g) continue;
        const cn = assetCnName(a);
        const aNameNoSpace = a.Name.replace(/\s+/g, "");
        if ((a.Description && (a.Description.includes(rawName) || a.Description.includes(noSpace))) ||
            (cn && (cn.includes(rawName) || cn.includes(noSpace))) ||
            aNameNoSpace.includes(noSpace))
          return { group: g, asset: a.Name };
      }
    }
    return null;
  }

  // itemadd/itemdel/itemset 的 part 兼容三种稳定表示：
  // 1. 语义部位（Arms / Devices）；
  // 2. BC 原生 group（ItemArms / ItemDevices）；
  // 3. 空值（使用 Asset 的默认 group）。
  // 原生 group 只有在 AssetGet 证实目标道具确实属于该 group 时才接受，
  // 防止为了兼容模型输出而重新引入“说绑手、实际绑脚”一类错位操作。
  function resolveItemPartGroups(char, itemName, part) {
    if (!char) return { ok: false, reason: "missing-character" };
    const mapping = findItemAsset(itemName, char);
    if (!mapping) {
      return { ok: false, reason: "unknown-item", item: itemName };
    }
    const rawPart = String(part || "").trim();
    if (!rawPart) {
      return {
        ok: true,
        asset: mapping.asset,
        defaultGroup: mapping.group,
        groups: [mapping.group],
        partKind: "default",
      };
    }

    if (BODY_PART_GROUPS[rawPart]) {
      const groups = BODY_PART_GROUPS[rawPart].filter(group =>
        !!AssetGet(char.AssetFamily, group, mapping.asset));
      if (groups.length === 0) {
        return {
          ok: false,
          reason: "incompatible-part",
          item: mapping.asset,
          part: rawPart,
        };
      }
      return {
        ok: true,
        asset: mapping.asset,
        defaultGroup: mapping.group,
        groups,
        partKind: "semantic",
      };
    }

    if (/^Item[A-Za-z0-9]+$/.test(rawPart)) {
      if (!AssetGet(char.AssetFamily, rawPart, mapping.asset)) {
        return {
          ok: false,
          reason: "incompatible-part",
          item: mapping.asset,
          part: rawPart,
        };
      }
      return {
        ok: true,
        asset: mapping.asset,
        defaultGroup: mapping.group,
        groups: [rawPart],
        partKind: "native-group",
      };
    }

    return {
      ok: false,
      reason: "unknown-part",
      item: mapping.asset,
      part: rawPart,
    };
  }

  // 拘束快照系统 - 存储玩家当前道具状态,用于"绑回去"


  // 按 snapshot 恢复玩家道具

  // 复制 src 玩家的道具到 dst 玩家

  // 直接修改 Appearance 数组(绕过 CharacterAppearanceSetItem 的权限检查)
  function directSetItem(char, groupName, asset, colorOverride, propertyOverride) {
    if (!char || !asset) return false;
    const idx = char.Appearance.findIndex(a => a.Asset?.Group?.Name === groupName);
    const defaultColor = Array.isArray(asset?.ColorSchema) ? asset.ColorSchema.map(() => "Default") : ["Default"];
    const entry = {
      Asset: asset,
      Color: colorOverride ? [...colorOverride] : defaultColor,
      Property: propertyOverride ? { ...propertyOverride } : {}
    };
    if (idx >= 0) char.Appearance[idx] = entry;
    else char.Appearance.push(entry);
    // 必须调 CharacterRefresh 重建渲染层,否则 BC 验证循环会重置
    if (typeof CharacterRefresh === "function") CharacterRefresh(char);
    return true;
  }

  // 只修改已有道具的颜色(不替换整个 entry)
  // colorOverride: hex 字符串或数组
  // layerIndex: 可选,指定改哪个 color slot(0-based),不传=全部改
  function directSetColor(char, groupName, colorOverride, layerIndex) {
    if (!char || !colorOverride) return false;
    const idx = char.Appearance.findIndex(a => a.Asset?.Group?.Name === groupName);
    if (idx < 0) return false;
    const item = char.Appearance[idx];
    const assetLayerCount = item.Asset?.ColorableLayerCount || item.Asset?.DefaultColor?.length || 1;
    // BC 服务器可能只存储被修改过的 color slot,导致 Color 数组比实际 layer 数短
    // 用 ColorableLayerCount 作为真正的长度,不足时用 DefaultColor 补齐
    if (!Array.isArray(item.Color) || item.Color.length < assetLayerCount) {
      const defaults = item.Asset?.DefaultColor || [];
      const newColor = [];
      for (let i = 0; i < assetLayerCount; i++) {
        newColor[i] = (item.Color && item.Color[i] !== undefined) ? item.Color[i] : (defaults[i] || "Default");
      }
      item.Color = newColor;
    }
    const expectedLen = item.Color.length;
    const hex = Array.isArray(colorOverride) ? colorOverride[0] : colorOverride;
    const useDefault = (hex === "Default");
    const fillValue = useDefault ? "Default" : hex;
    if (layerIndex !== undefined && layerIndex >= 0 && layerIndex < expectedLen) {
      item.Color[layerIndex] = fillValue;
    } else if (layerIndex === undefined) {
      // 没指定 layer → 改全部（保留原行为）
      item.Color = Array(expectedLen).fill(fillValue);
    } else {
      // layerIndex 无效 → 不改，避免误操作
      console.warn(`[MisakaChat] layerIndex ${layerIndex} 超出范围(0-${expectedLen-1}),跳过改色`);
      return false;
    }
    if (typeof CharacterRefresh === "function") CharacterRefresh(char);
    return true;
  }

  // 找道具的可上色 layer 名列表
  function getItemColorLayers(asset) {
    if (!asset?.Layer) return [];
    const layers = [];
    for (const layer of asset.Layer) {
      // 只有 AllowColorize=true 的 layer 才可上色
      // 用 ColorIndex 属性获取真正的 color slot 索引
      if (layer.AllowColorize === true && typeof layer.ColorIndex === "number") {
        layers.push({ name: layer.Name, index: layer.ColorIndex });
      }
    }
    // fallback: 如果没找到 AllowColorize 的 layer,用旧逻辑
    if (layers.length === 0) {
      const count = asset.ColorableLayerCount || asset.DefaultColor?.length || 0;
      let colorIdx = 0;
      for (const layer of asset.Layer) {
        if (colorIdx >= count) break;
        layers.push({ name: layer.Name, index: colorIdx });
        colorIdx++;
      }
    }
    return layers;
  }

  // 只在目标道具的 layer 里做本地匹配，不做全局反查
  function findLayerIndex(asset, layerName) {
    if (!layerName) return undefined;
    const layers = getItemColorLayers(asset);
    const raw = String(layerName).trim();
    const lower = raw.toLowerCase();
    // 1. 精确匹配英文名
    let found = layers.find(l => l.name === raw || l.name?.toLowerCase() === lower);
    // 2. 在本道具内做中文名匹配（layerCnName 逐个比对）
    if (!found) {
      found = layers.find(l => {
        const cn = MisakaPersona?.layerCnName?.({ Name: l.name }) || "";
        return cn === raw || cn.toLowerCase() === lower;
      });
    }
    // 3. 本道具内中文 includes 模糊匹配
    if (!found) {
      found = layers.find(l => {
        const cn = MisakaPersona?.layerCnName?.({ Name: l.name }) || "";
        return cn && (cn.includes(raw) || raw.includes(cn)) && cn.length > 1;
      });
    }
    return found?.index;
  }

  function directRemoveItem(char, groupName) {
    if (!char) return false;
    const idx = char.Appearance.findIndex(a => a.Asset?.Group?.Name === groupName);
    if (idx < 0) return false;
    char.Appearance.splice(idx, 1);
    if (typeof CharacterRefresh === "function") CharacterRefresh(char);
    return true;
  }


  function colorNameToHex(name) {
    if (!name) return null;
    const n = name.trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(n)) return n.toUpperCase();
    if (/默认|Default|原色/.test(n)) return "Default";
    return null;
  }

  const PROPERTY_MAP = {
    "Intensity": { type: "vibrator" },
    "Vibration": { type: "vibrator" },
    "Mode": { type: "vibrator" },
    "Switch": { type: "direct", key: "SetState", values: { "On": true, "Off": false } },
    "Type": { type: "typed" },
    "Style": { type: "typed" },
    "Opacity": { type: "direct", key: "Opacity", values: null },
  };

  // 通用:通过 archetype 正规设置道具属性
  // 会同步 TypeRecord + Property,避免 BC 验证循环重置

  // 振动器标准选项(TypeRecord.vibrating 索引 → 选项名)
  const VIBRATOR_OPTIONS = [
    { name: "Off",     mode: "Off",     intensity: -1, effect: ["Egged"],               tr: 0 },
    { name: "Low",     mode: "Low",     intensity: 0,  effect: ["Egged","Vibrating"],   tr: 1 },
    { name: "Medium",  mode: "Medium",  intensity: 1,  effect: ["Egged","Vibrating"],   tr: 2 },
    { name: "High",    mode: "High",    intensity: 2,  effect: ["Egged","Vibrating"],   tr: 3 },
    { name: "Maximum", mode: "Maximum", intensity: 3,  effect: ["Egged","Vibrating"],   tr: 4 },
    { name: "Random",  mode: "Random",  intensity: 0,  effect: ["Egged"],               tr: 5 },
    { name: "Escalate",mode: "Escalate",intensity: 0,  effect: ["Egged","Vibrating"],   tr: 6 },
    { name: "Tease",   mode: "Tease",   intensity: 0,  effect: ["Egged"],               tr: 7 },
    { name: "Deny",    mode: "Deny",    intensity: 0,  effect: ["Egged","Edged"],       tr: 8 },
    { name: "Edge",    mode: "Edge",    intensity: 0,  effect: ["Egged","Vibrating","Edged"], tr: 9 },
  ];





  // 在 setExtendedItemProperty 的 typed 分支里用动态 BC 选项,中文表只作 fallback
  // 返回 BC 选项名(英文),而非索引
  function findTypedOptionName(item, valueName) {
    try {
      const key = item.Asset.Group.Name + item.Asset.Name;
      const data = TypedItemDataLookup[key];
      if (data?.options) {
        const opt = data.options.find(o => o.Name === valueName || o.Name?.toLowerCase() === valueName.toLowerCase());
        if (opt) return opt.Name;
      }
    } catch(e) {}
    return null;
  }


  function findModularOption(asset, moduleKey, valueName) {
    try {
      const key = asset.Group.Name + asset.Name;
      const data = typeof ModularItemDataLookup !== "undefined" && ModularItemDataLookup[key];
      const modules = data?.modules || data?.Modules || [];
      const mod = Array.isArray(modules)
        ? modules.find(m => {
            const names = [m.Key, m.Name, m.Property].filter(Boolean).map(String);
            return names.some(n => n === moduleKey || n.toLowerCase() === String(moduleKey).toLowerCase());
          })
        : null;
      const options = mod?.Options || mod?.options || [];
      const numeric = parseInt(valueName, 10);
      if (!Number.isNaN(numeric) && options[numeric]) return { index: numeric, option: options[numeric] };
      const idx = options.findIndex(o => {
        const name = typeof o === "string" ? o : (o?.Name || o?.Property || o?.Option || o?.Type || "");
        return name === valueName || String(name).toLowerCase() === String(valueName).toLowerCase();
      });
      return idx >= 0 ? { index: idx, option: options[idx] } : null;
    } catch(e) {
      return null;
    }
  }


  // 通用:设置 Extended 道具属性
  function setExtendedItemProperty(char, item, propName, valueName) {
    if (!item || !item.Asset) return { ok: false, msg: "道具不存在" };
    if (item.Property?.LockedBy) return { ok: false, msg: "道具被锁" };

    const archetype = item.Asset.Archetype;
    if (!item.Property) item.Property = {};
    if (!item.Property.TypeRecord) item.Property.TypeRecord = {};

    const fallbackProperty = PROPERTY_MAP[propName];
    if (fallbackProperty?.type === "direct") {
      item.Property[fallbackProperty.key] = (fallbackProperty.values && Object.prototype.hasOwnProperty.call(fallbackProperty.values, valueName)) ? fallbackProperty.values[valueName] : valueName;
      updateCharacter(char);
      return { ok: true, msg: `已设置 ${item.Asset.Description} ${fallbackProperty.key}=${item.Property[fallbackProperty.key]}` };
    }

    if (archetype === "vibrating") {
      // 振动器:propName 应该是 "强度" 或 "震动" 或 "模式"
      const opt = VIBRATOR_OPTIONS.find(o => o.name.toLowerCase() === valueName.toLowerCase());
      if (!opt) return { ok: false, msg: `未知振动档位: ${valueName}` };
      return applyVibratorOption(char, item, opt);
    }

    if (archetype === "typed") {
      const optName = findTypedOptionName(item, valueName);
      if (!optName) return { ok: false, msg: `无法识别样式: ${valueName}(道具: ${item.Asset.Description})` };
      TypedItemSetOptionByName(char, item, optName, true, null, true);
      return { ok: true, msg: `已设置 ${item.Asset.Description} 样式=${optName}` };
    }

    if (archetype === "modular") {
      // modular 道具:TypeRecord 有多个 key
      // propName 格式:模块key(如 g/h/c/b/e),valueName:选项名或索引
      const trKey = propName;
      const match = findModularOption(item.Asset, trKey, valueName);
      if (!match) return { ok: false, msg: `modular 模块 ${trKey} 无法识别选项: ${valueName}` };
      const optionProperty = (match.option && typeof match.option === "object" && match.option.Property) ? match.option.Property : null;
      if (optionProperty) {
        const previousTypeRecord = { ...(item.Property.TypeRecord || {}) };
        Object.assign(item.Property, JSON.parse(JSON.stringify(optionProperty)));
        item.Property.TypeRecord = { ...previousTypeRecord, ...(item.Property.TypeRecord || {}), [trKey]: match.index };
      } else {
        item.Property.TypeRecord[trKey] = match.index;
      }
      updateCharacter(char);
      return { ok: true, msg: `已设置 ${item.Asset.Description} 模块 ${trKey}=${match.index}` };
    }

    // 非 Extended 道具 - 直接设 Property
    if (!item.Property) item.Property = {};
    item.Property[propName] = valueName;
    updateCharacter(char);
    return { ok: true, msg: `已设置 ${item.Asset.Description} ${propName}=${valueName}` };
  }

  function applyVibratorOption(char, item, opt) {
    // 用 BC 正规 API:VibratorModeSetOptionByName
    try {
      if (typeof VibratorModeSetOptionByName === "function") {
        VibratorModeSetOptionByName(char, item, opt.name, true, null, true);
        return { ok: true, msg: `已设置 ${item.Asset.Description} ${opt.name}` };
      }
    } catch(e) { console.warn("[MisakaChat] VibratorModeSetOptionByName 失败:", e.message); }

    // fallback: 手动设置
    if (!item.Property) item.Property = {};
    if (!item.Property.TypeRecord) item.Property.TypeRecord = {};
    const lockFields = {};
    for (const k of ["LockedBy","LockMemberNumber","LockMemberName","Name","OverridePriority"]) {
      if (item.Property[k] !== undefined) lockFields[k] = item.Property[k];
    }
    item.Property.Mode = opt.mode;
    item.Property.Intensity = opt.intensity;
    item.Property.Effect = [...opt.effect];
    const trKey = Object.keys(item.Property.TypeRecord)[0] || "vibrating";
    item.Property.TypeRecord[trKey] = opt.tr;
    Object.assign(item.Property, lockFields);
    updateCharacter(char);
    return { ok: true, msg: `已设置 ${item.Asset.Description} ${opt.name}` };
  }

  // 设置已有道具的属性(强度/绑法/开关等)
  function executeItemColor(memberNumber, itemName, part, colorName) {
    console.log(`[MisakaChat] 改颜色: #${memberNumber} ${itemName} part=${part} color=${colorName}`);
    const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
    if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return { ok: false, reason: "missing-character" }; }
    const mapping = findItemAsset(itemName, char);
    if (!mapping) { console.log("[MisakaChat] 找不到道具: " + itemName); return { ok: false, reason: "unknown-item" }; }
    console.log(`[MisakaChat] findItemAsset → group=${mapping.group} asset=${mapping.asset}`);
    // findItemAsset 返回 { group, asset },需要从 BC Asset 数组里找真正的 Asset 对象
    const realAsset = Asset.find(a => a.Name === mapping.asset && a.Group?.Name === mapping.group);
    if (!realAsset) { console.log("[MisakaChat] 找不到 Asset 对象: " + mapping.asset); return { ok: false, reason: "missing-asset" }; }
    const groupName = mapping.group;
    const hex = colorNameToHex(colorName);
    if (!hex) { console.log("[MisakaChat] 未知颜色: " + colorName); return { ok: false, reason: "unknown-color" }; }

    // part 可能是身体部位(如"腿")或道具部件名(如"毛毯")
    // 先检查是不是身体部位
    if (part && BODY_PART_GROUPS[part]) {
      const groupList = BODY_PART_GROUPS[part];
      if (groupList && groupList.length > 0) {
        let ok = false;
        for (const g of groupList) {
          if (directSetColor(char, g, [hex])) ok = true;
        }
        if (ok) { updateCharacter(char); console.log("[MisakaChat] ✅ 颜色已改", part, colorName); }
        return ok ? { ok: true } : { ok: false, reason: "missing-part-item", memberNumber, item: itemName };
      }
    }

    const existingItem = char.Appearance.find(a => a.Asset?.Group?.Name === groupName);
    if (!existingItem) {
      const torsoItems = char.Appearance.filter(a => a.Asset?.Group?.Name?.startsWith("ItemTorso")).map(a => `${a.Asset.Name}(${a.Asset.Group.Name})`);
      console.log(`[MisakaChat] #${memberNumber} 身上没有 ${itemName}(group=${groupName}),不硬加。身上 Torso 道具: ${torsoItems.join(",") || "无"}`);
      return { ok: false, reason: "missing-item", memberNumber, item: itemName };
    }

    // part 是道具部件名(layer name)
    let layerIndex = undefined;
    if (part && !BODY_PART_GROUPS[part]) {
      layerIndex = findLayerIndex(realAsset, part);
      if (layerIndex === undefined) {
        const available = getItemColorLayers(realAsset).map(l => {
          const cn = MisakaPersona?.layerCnName?.({ Name: l.name }) || "";
          return cn && cn !== l.name ? `${l.name}(${cn})` : l.name;
        }).join("/");
        console.log(`[MisakaChat] 找不到部件 "${part}",可上色部件: ${available}`);
        return { ok: false, reason: `找不到部件「${part}」,可上色部件: ${available}`, memberNumber, item: itemName };
      }
    }

    const ok = directSetColor(char, groupName, [hex], layerIndex);
    if (ok) { updateCharacter(char); console.log("[MisakaChat] ✅ 颜色已改", itemName, part || "全部", colorName); }
    return ok ? { ok: true } : { ok: false, reason: "set-color-failed", memberNumber, item: itemName };
  }

  function executeItemSet(memberNumber, itemName, part, propName, valueName) {
    try {
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber); if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return { ok: false, reason: "missing-character" }; }
      let target = findItemByPart(char, itemName, part);
      if (!target && !part) {
        const mapping = findItemAsset(itemName, char);
        if (mapping) {
          target = char.Appearance.find(a => a?.Asset?.Group?.Name === mapping.group);
          if (!target) {
            target = char.Appearance.find(a => a?.Asset?.Group?.Name?.startsWith("Item") && a?.Asset?.Name === mapping.asset);
          }
        }
      }
      if (!target) { console.log("[MisakaChat] ITEMSET 找不到道具:", itemName); return { ok: false, reason: "missing-item", memberNumber, item: itemName }; }

      const result = setExtendedItemProperty(char, target, propName, valueName);
      if (result.ok) {
        console.log(`[MisakaChat] ITEMSET 成功: #${memberNumber} ${result.msg}`);
      } else {
        console.log(`[MisakaChat] ITEMSET 失败: #${memberNumber} ${result.msg}`);
      }
      return result.ok ? { ok: true } : { ok: false, reason: result.msg || "itemset-failed" };
    } catch(e) {
      console.error("[MisakaChat] 设置道具属性失败:", e.message);
      return { ok: false, reason: e.message };
    }
  }

  function findEmptyGroup(char, groups, assetName) {
    // 先找空 group,再找有同名 asset 的 group(覆盖)
    for (const g of groups) {
      if (!char.Appearance.find(a => a?.Asset?.Group?.Name === g) && AssetGet(char.AssetFamily, g, assetName))
        return g;
    }
    for (const g of groups) {
      if (AssetGet(char.AssetFamily, g, assetName)) return g;
    }
    return null;
  }

  function resolveItemAddTarget(char, itemName, part) {
    const resolution = resolveItemPartGroups(char, itemName, part);
    if (!resolution.ok) return resolution;
    const targetGroup = String(part || "").trim()
      ? findEmptyGroup(char, resolution.groups, resolution.asset)
      : (char.Appearance.find(a => a.Asset?.Group?.Name === resolution.defaultGroup)
          ? (findEmptyGroup(char, [
              resolution.defaultGroup,
              ...Asset.filter(a =>
                a?.Group?.Name?.startsWith("Item") &&
                a.Name === resolution.asset &&
                a.Group.Name !== resolution.defaultGroup
              ).map(a => a.Group.Name),
            ], resolution.asset) || resolution.defaultGroup)
          : resolution.defaultGroup);
    if (!targetGroup) {
      return {
        ok: false,
        reason: "incompatible-part",
        item: resolution.asset,
        part: String(part || "").trim(),
      };
    }
    const targetAsset = AssetGet(char.AssetFamily, targetGroup, resolution.asset);
    if (!targetAsset) {
      return {
        ok: false,
        reason: "unknown-item",
        item: resolution.asset,
        part: String(part || "").trim(),
      };
    }
    return {
      ok: true,
      group: targetGroup,
      asset: resolution.asset,
      targetAsset,
      partKind: resolution.partKind,
    };
  }

  function executeItemAdd(memberNumber, itemName, part, color) {
    try {
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
      if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return { ok: false, reason: "missing-character" }; }
      const resolved = resolveItemAddTarget(char, itemName, part);
      if (!resolved.ok) {
        console.log("[MisakaChat] ITEMADD 无法解析目标:", itemName, part || "(默认)", resolved.reason);
        return { ...resolved, memberNumber, item: itemName };
      }
      const targetGroup = resolved.group;
      const targetAsset = resolved.targetAsset;

      // 颜色覆盖
      let colorOverride = null;
      if (color) {
        const hex = colorNameToHex(color);
        if (hex) {
          const cs = targetAsset?.ColorSchema;
          colorOverride = Array.isArray(cs) ? cs.map(() => hex) : [hex];
        } else return { ok: false, reason: "unknown-color", memberNumber, item: itemName };
      }
      const existingItem = char.Appearance.find(a => a.Asset?.Group?.Name === targetGroup);
      if (existingItem && colorOverride) directSetColor(char, targetGroup, colorOverride);
      else directSetItem(char, targetGroup, targetAsset, colorOverride);
      updateCharacter(char);
      console.log(`[MisakaChat] 已给 #${memberNumber} 添加 ${itemName} (group: ${targetGroup})`);
      return { ok: true };
    } catch(e) {
      console.error("[MisakaChat] 添加道具失败:", e.message);
      return { ok: false, reason: e.message };
    }
  }

  function executeItemDel(memberNumber, itemName, part) {
    try {
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber); if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return { ok: false, reason: "missing-character" }; }

      console.log(`[MisakaChat] executeItemDel #${memberNumber} item="${itemName}" part="${part||""}"`);

      // 使用 findItemByPart 支持部位限定
      let target = findItemByPart(char, itemName, part);

      // fallback: findItemAsset mapping
      if (!target && !part) {
        const mapping = findItemAsset(itemName, char);
        if (mapping) {
          target = char.Appearance.find(a => a?.Asset?.Group?.Name === mapping.group);
          if (!target) {
            target = char.Appearance.find(a =>
              a?.Asset?.Group?.Name?.startsWith("Item") &&
              a?.Asset?.Name === mapping.asset
            );
          }
        }
      }
      if (!target) { console.log("[MisakaChat] 找不到道具:", itemName, part ? "(部位:" + part + ")" : ""); return { ok: false, reason: "missing-item", memberNumber, item: itemName }; }
      if (target?.Property?.LockedBy) {
        console.log(`[MisakaChat] 道具被锁: ${target.Property.LockedBy}`);
        return { ok: false, reason: "locked-item", memberNumber, item: itemName };
      }
      const groupName = target.Asset.Group.Name;
      console.log(`[MisakaChat] 准备移除 #${memberNumber} group=${groupName} desc=${target.Asset.Description}`);
      directRemoveItem(char, groupName);
      updateCharacter(char);
      console.log(`[MisakaChat] 已移除 #${memberNumber} 的 ${itemName} (group: ${target.Asset.Group.Name})`);
      return { ok: true };
    } catch(e) {
      console.error("[MisakaChat] 移除道具失败:", e.message);
      return { ok: false, reason: e.message };
    }
  }

  // 释放全部未锁道具
  function executeItemDelAll(memberNumber) {
    try {
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
      if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return false; }
      if (!char) return false;
      let count = 0;
      const toRemove = (char.Appearance || [])
        .filter(a => a?.Asset?.Group?.Name?.startsWith("Item") && !a.Property?.LockedBy)
        .map(a => a.Asset.Group.Name);
      console.log("[MisakaChat] itemDelAll 待移除:", toRemove);
      for (const groupName of toRemove) {
        try {
          const ok = directRemoveItem(char, groupName);
          if (ok) count++;
          else console.log("[MisakaChat] itemDelall 移除失败:", groupName);
        } catch(e) { console.error("[MisakaChat] itemDelall 异常:", groupName, e.message); }
      }
      updateCharacter(char);
      console.log(`[MisakaChat] 释放 #${memberNumber} 全部道具: ${count}/${toRemove.length} 件`);
      return count > 0;
    } catch(e) {
      console.error("[MisakaChat] 释放全部失败:", e.message);
      return false;
    }
  }

  // === SNAPSHOT / COPY ===
  function cloneItemForSnapshot(item) {
    const copy = { ...item, Asset: item.Asset };
    if (Array.isArray(item.Color)) copy.Color = item.Color.slice();
    if (item.Property) copy.Property = JSON.parse(JSON.stringify(item.Property));
    if (item.Craft) copy.Craft = JSON.parse(JSON.stringify(item.Craft));
    return copy;
  }

  // 提取角色身上所有未锁 Item 类道具的快照副本
  function extractItems(char) {
    if (!char || !Array.isArray(char.Appearance)) return [];
    return char.Appearance
      .filter(a => a?.Asset?.Group?.Name?.startsWith("Item") && !a.Property?.LockedBy)
      .map(cloneItemForSnapshot);
  }

  // 将道具列表直接写入角色 Appearance 并同步
  function applyItems(char, items) {
    if (!char || !Array.isArray(char.Appearance)) return 0;
    // 先移除现有未锁 Item
    char.Appearance = char.Appearance.filter(a => !a?.Asset?.Group?.Name?.startsWith("Item") || a.Property?.LockedBy);
    let count = 0;
    for (const item of items) {
      try {
        char.Appearance.push(cloneItemForSnapshot(item));
        count++;
      } catch(e) { console.error("[MisakaChat] applyItems push 失败:", e.message); }
    }
    updateCharacter(char);
    return count;
  }

  function executeSnapshotSave(memberNumber) {
    try {
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
      if (!char) return { ok: false, reason: "找不到玩家" };
      const items = extractItems(char);
      if (items.length === 0) return { ok: false, reason: "没有可保存的未锁道具" };
      state.snapshots[memberNumber] = { items, time: Date.now() };
      console.log(`[MisakaChat] 快照已保存: #${memberNumber} ${items.length}件道具`);
      return { ok: true, msg: `保存了 ${items.length} 件道具` };
    } catch(e) {
      console.error("[MisakaChat] 快照保存失败:", e.message);
      return { ok: false, reason: e.message };
    }
  }

  function executeSnapshotRestore(memberNumber) {
    try {
      const snap = state.snapshots[memberNumber];
      if (!snap) return { ok: false, reason: "没有找到快照" };
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
      if (!char) return { ok: false, reason: "找不到玩家" };
      const count = applyItems(char, snap.items);
      console.log(`[MisakaChat] 快照已恢复: #${memberNumber} ${count}/${snap.items.length}件道具`);
      return { ok: true, msg: `恢复了 ${count}/${snap.items.length} 件道具` };
    } catch(e) {
      console.error("[MisakaChat] 快照恢复失败:", e.message);
      return { ok: false, reason: e.message };
    }
  }

  function executeCopyRestraint(sourceNumber, targetNumber) {
    try {
      const src = ChatRoomCharacter.find(c => c.MemberNumber === sourceNumber);
      const dst = (targetNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === targetNumber);
      if (!src) return { ok: false, reason: "找不到源玩家" };
      if (!dst) return { ok: false, reason: "找不到目标玩家" };
      const items = extractItems(src);
      if (items.length === 0) return { ok: false, reason: "没有可复制的未锁道具" };
      const count = applyItems(dst, items);
      console.log(`[MisakaChat] 束缚已复制: #${sourceNumber} -> #${targetNumber} ${count}/${items.length}件`);
      return { ok: true, msg: `复制了 ${count}/${items.length} 件道具` };
    } catch(e) {
      console.error("[MisakaChat] 束缚复制失败:", e.message);
      return { ok: false, reason: e.message };
    }
  }

  // 发送回复到 BC 聊天室(含去重 + 多行分割)
  function sendReply(text) {
    if (!text || !isCurrent()) return false;
    const sentKey = text;
    const now = Date.now();
    if (window.__misakaLastSentReply === sentKey && now - (window.__misakaLastSentReplyTime || 0) < 5000) {
      console.warn("[MisakaChat] 跳过重复发送:", text);
      return false;
    }
    window.__misakaLastSentReply = sentKey;
    window.__misakaLastSentReplyTime = now;
    if (typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom") {
      let parts = text.split(/\n/).map(p => p.trim()).filter(Boolean);
      if (parts.length === 1 && parts[0].includes("|")) parts = parts[0].split(/\|/).map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        let delay = 0;
        for (const p of parts) {
          if (!p) continue;
          trackedTimeout(() => {
            ElementValue("InputChat", p);
            ChatRoomSendChat();
          }, delay);
          delay += 600;
        }
      } else { ElementValue("InputChat", parts[0] || text); ChatRoomSendChat(); }
      if (state.recentMessages.length > CONFIG.maxContext) state.recentMessages.shift();
    }
    return true;
  }

  function isAllowedStickerUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" &&
        /\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname);
    } catch (e) {
      return false;
    }
  }

  function getStickerCatalog() {
    const byId = new Map(BUILTIN_STICKER_CATALOG.map(sticker => [sticker.id, { ...sticker }]));
    try {
      const extra = JSON.parse(localStorage.getItem(storageKey("sticker_catalog")) || "[]");
      for (const raw of Array.isArray(extra) ? extra : []) {
        const id = String(raw?.id || "").trim();
        const url = String(raw?.url || "").trim();
        if (!/^[a-z0-9_-]{2,40}$/i.test(id) || !isAllowedStickerUrl(url) || byId.has(id)) continue;
        byId.set(id, {
          id,
          url,
          label: String(raw?.label || id).trim().slice(0, 60),
          tags: (Array.isArray(raw?.tags) ? raw.tags : [])
            .map(tag => String(tag || "").trim().slice(0, 30))
            .filter(Boolean)
            .slice(0, 12),
        });
      }
    } catch (e) {
      pushDebugTrace({ stage: "sticker:catalog-invalid", reason: e.message });
    }
    return [...byId.values()];
  }

  function compactStickerCatalog() {
    return getStickerCatalog()
      .map(sticker => `${sticker.id}=${sticker.label}(${sticker.tags.join("、")})`)
      .join("; ");
  }

  function stickerDailyKey(now = new Date()) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function stickerCooldownStatus(stickerId) {
    const now = Date.now();
    const today = stickerDailyKey(new Date(now));
    const dailyCount = state.stickerDaily.date === today ? state.stickerDaily.count : 0;
    const globalRemaining = CONFIG.stickerCooldownMs - (now - state.lastStickerTime);
    const repeatRemaining = CONFIG.stickerRepeatCooldownMs -
      (now - (state.lastStickerById[stickerId] || 0));
    return {
      ready: globalRemaining <= 0 && repeatRemaining <= 0 && dailyCount < CONFIG.stickerDailyLimit,
      globalRemaining: Math.max(0, globalRemaining),
      repeatRemaining: Math.max(0, repeatRemaining),
      dailyRemaining: Math.max(0, CONFIG.stickerDailyLimit - dailyCount),
    };
  }

  function resolveSticker(stickerId) {
    const id = String(stickerId || "").trim();
    if (!id) return { ok: false, reason: "sticker-not-requested" };
    const sticker = getStickerCatalog().find(item => item.id === id);
    if (!sticker) return { ok: false, reason: "sticker-unknown", stickerId: id };
    if (!CONFIG.stickerEnabled) return { ok: false, reason: "sticker-disabled", stickerId: id };
    const cooldown = stickerCooldownStatus(id);
    if (!cooldown.ready) return { ok: false, reason: "sticker-cooldown", stickerId: id, cooldown };
    return { ok: true, sticker };
  }

  function sendSticker(stickerId, options = {}) {
    const resolved = resolveSticker(stickerId);
    if (!resolved.ok) return resolved;
    if (options.dryRun === true) return { ok: true, dryRun: true, sticker: resolved.sticker };
    try {
      if (typeof CurrentScreen === "undefined" || CurrentScreen !== "ChatRoom") {
        return { ok: false, reason: "not-in-chatroom" };
      }
      const now = Date.now();
      const today = stickerDailyKey(new Date(now));
      if (state.stickerDaily.date !== today) state.stickerDaily = { date: today, count: 0 };
      ElementValue("InputChat", `( ${resolved.sticker.url} )`);
      ChatRoomSendChat();
      state.lastStickerTime = now;
      state.lastStickerById[resolved.sticker.id] = now;
      state.stickerDaily.count += 1;
      const result = {
        ok: true,
        stickerId: resolved.sticker.id,
        url: resolved.sticker.url,
        dailyCount: state.stickerDaily.count,
      };
      pushDebugTrace({ stage: "sticker:sent", ...result });
      return result;
    } catch (e) {
      pushDebugTrace({ stage: "sticker:send-failed", stickerId, reason: e.message });
      return { ok: false, reason: e.message || "sticker-send-failed" };
    }
  }

  function scheduleStickerAfterReply(reply, stickerId, debugId) {
    const resolved = resolveSticker(stickerId);
    pushDebugTrace({ id: debugId, stage: "sticker:planned", stickerId, resolved });
    if (!resolved.ok) return false;
    const messageCount = String(reply || "").split(/\n|\|/).map(v => v.trim()).filter(Boolean).length;
    const delay = Math.max(900, messageCount * 650 + 250);
    trackedTimeout(() => {
      const result = sendSticker(stickerId);
      pushDebugTrace({ id: debugId, stage: "sticker:result", result });
    }, delay);
    return true;
  }

  function loadFriendAudit() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey("friend_audit")) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveFriendAudit(audit) {
    try {
      localStorage.setItem(storageKey("friend_audit"), JSON.stringify(audit || {}));
    } catch (e) {
      pushDebugTrace({ stage: "friend:audit-save-failed", reason: e.message });
    }
  }

  function friendRelationshipStatus(memberNumber) {
    const mn = Number(memberNumber);
    const target = characterByMemberNumber(mn);
    if (!target) return { eligible: false, reason: "target-not-in-room", memberNumber: mn };
    const name = target.Nickname || target.Name || `#${mn}`;
    if (!Number.isInteger(mn) || mn < 0 || mn === Number(Player?.MemberNumber)) {
      return { eligible: false, reason: "invalid-target", memberNumber: mn, name };
    }
    if (/^gimp\s*\d+/i.test(name)) {
      return { eligible: false, reason: "automated-doll", memberNumber: mn, name };
    }
    const inList = list => Array.isArray(list) && list.map(Number).includes(mn);
    if (typeof Player?.HasOnFriendlist === "function" && Player.HasOnFriendlist(mn)) {
      return { eligible: false, reason: "already-friend", memberNumber: mn, name };
    }
    if (inList(Player?.FriendList)) return { eligible: false, reason: "already-friend", memberNumber: mn, name };
    if (inList(Player?.BlackList)) return { eligible: false, reason: "blacklisted", memberNumber: mn, name };
    if (inList(Player?.GhostList)) return { eligible: false, reason: "ghosted", memberNumber: mn, name };
    return { eligible: true, memberNumber: mn, name, target };
  }

  function friendDailyKey(now = new Date()) {
    return stickerDailyKey(now);
  }

  function loadFriendRateState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey("friend_rate")) || "{}");
      return {
        lastTime: Math.max(0, Number(parsed?.lastTime) || 0),
        daily: {
          date: String(parsed?.daily?.date || ""),
          count: Math.max(0, Number(parsed?.daily?.count) || 0),
        },
      };
    } catch (e) {
      return { lastTime: 0, daily: { date: "", count: 0 } };
    }
  }

  function saveFriendRateState() {
    try {
      localStorage.setItem(storageKey("friend_rate"), JSON.stringify({
        lastTime: state.lastAutoFriendTime,
        daily: state.autoFriendDaily,
      }));
    } catch (e) {
      pushDebugTrace({ stage: "friend:rate-save-failed", reason: e.message });
    }
  }

  function friendRateLimitStatus() {
    const now = Date.now();
    const today = friendDailyKey(new Date(now));
    const dailyCount = state.autoFriendDaily.date === today ? state.autoFriendDaily.count : 0;
    const remainingMs = CONFIG.autoFriendCooldownMs - (now - state.lastAutoFriendTime);
    return {
      ready: remainingMs <= 0 && dailyCount < CONFIG.autoFriendDailyLimit,
      remainingMs: Math.max(0, remainingMs),
      dailyRemaining: Math.max(0, CONFIG.autoFriendDailyLimit - dailyCount),
    };
  }

  function addNativeFriend(memberNumber, meta = {}, options = {}) {
    if (!CONFIG.autoFriendEnabled && options.ignoreFeatureSwitch !== true) {
      return { ok: false, reason: "friend-disabled" };
    }
    const relationship = friendRelationshipStatus(memberNumber);
    if (!relationship.eligible) return { ok: false, ...relationship };
    const useAutoRateLimit = options.ignoreRateLimit !== true;
    const rateLimit = friendRateLimitStatus();
    if (useAutoRateLimit && !rateLimit.ready) {
      return { ok: false, reason: "friend-rate-limit", rateLimit };
    }
    if (options.dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        memberNumber: relationship.memberNumber,
        name: relationship.name,
        mode: meta.mode || "unknown",
      };
    }
    if (typeof ChatRoomListUpdate !== "function" || typeof ServerPlayerRelationsSync !== "function") {
      return { ok: false, reason: "friend-api-unavailable" };
    }
    try {
      ChatRoomListUpdate(Player.FriendList, true, relationship.memberNumber, "FriendRequest", false);
      ServerPlayerRelationsSync();
      if (typeof ServerSend === "function") ServerSend("AccountQuery", { Query: "OnlineFriends" });
      const now = Date.now();
      if (useAutoRateLimit) {
        const today = friendDailyKey(new Date(now));
        if (state.autoFriendDaily.date !== today) state.autoFriendDaily = { date: today, count: 0 };
        state.lastAutoFriendTime = now;
        state.autoFriendDaily.count += 1;
        saveFriendRateState();
      }
      const audit = loadFriendAudit();
      audit[relationship.memberNumber] = {
        status: "added",
        time: new Date(now).toISOString(),
        name: relationship.name,
        mode: meta.mode || "unknown",
        reason: String(meta.reason || "").slice(0, 240),
        evidence: (Array.isArray(meta.evidence) ? meta.evidence : [])
          .map(value => String(value || "").slice(0, 300))
          .slice(0, 5),
      };
      saveFriendAudit(audit);
      const result = {
        ok: true,
        memberNumber: relationship.memberNumber,
        name: relationship.name,
        mode: meta.mode || "unknown",
        dailyCount: useAutoRateLimit ? state.autoFriendDaily.count : null,
      };
      pushDebugTrace({ stage: "friend:added", ...result, reason: meta.reason || "" });
      return result;
    } catch (e) {
      pushDebugTrace({ stage: "friend:add-failed", memberNumber, reason: e.message });
      return { ok: false, reason: e.message || "friend-add-failed" };
    }
  }

  function buildAutoFriendEvidence(memberNumber, currentContent = "") {
    const mn = Number(memberNumber);
    const profile = loadMemory()?.profiles?.[mn] || {};
    const candidates = state.semanticMemories
      .filter(memory => Number(memory?.memberNum) === mn && !memory?.isSelf)
      .sort((a, b) => Number(b?.time || 0) - Number(a?.time || 0))
      .slice(0, 20);
    const seen = new Set();
    const messages = [];
    for (const memory of candidates) {
      const text = String(memory?.text || "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      messages.push({
        text: text.slice(0, 300),
        time: Number(memory?.time || 0),
        addressedToBot: memory?.addressedToBot === true,
      });
      if (messages.length >= 10) break;
    }
    const current = String(currentContent || "").trim();
    if (current && !messages.some(message => message.text.endsWith(current))) {
      messages.unshift({ text: current.slice(0, 300), time: Date.now(), addressedToBot: true });
    }
    return {
      interactionCount: Number(profile?.chatCount || 0),
      directCount: messages.filter(message => message.addressedToBot).length,
      messages,
    };
  }

  function parseFriendDecision(raw) {
    try {
      const text = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const parsed = JSON.parse(text);
      return {
        decision: parsed?.decision === "add" ? "add" : "skip",
        confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)),
        evidence: (Array.isArray(parsed?.evidence) ? parsed.evidence : [])
          .map(Number).filter(Number.isInteger).slice(0, 5),
        reason: String(parsed?.reason || "").trim().slice(0, 240),
      };
    } catch (e) {
      return { decision: "skip", confidence: 0, evidence: [], reason: "parse-failed" };
    }
  }

  async function classifyFriendEvidence(memberNumber, senderName, evidence) {
    const numbered = evidence.messages
      .map((message, index) => `${index}. ${message.addressedToBot ? "[直接对御坂]" : "[房间消息]"} ${message.text}`)
      .join("\n");
    const system = `你是 BC 自动加好友的保守证据审查器。只输出严格 JSON：
{"decision":"add|skip","confidence":0到1,"evidence":[证据编号],"reason":"一句理由"}
只有至少两条不同的直接证据共同表明此人持续、友善且真诚地与御坂互动，才可 add。
普通寒暄、单次玩笑、仅仅同处一室、互动次数很多、第三人评价、性/束缚玩法本身都不是充分证据。
出现敌意、羞辱、冲突、拒绝、边界不明、强迫、证据含糊或前后矛盾，一律 skip。
不要推测未写出的感情；只使用编号证据。add 必须 confidence>=0.92 且至少引用两条直接对御坂的证据。`;
    const raw = await callLLM(system, [{
      role: "user",
      content: `候选：${senderName}#${memberNumber}\n总互动计数：${evidence.interactionCount}\n候选证据：\n${numbered}`,
    }], { thinking: false, temperature: 0, maxTokens: 220 });
    const decision = parseFriendDecision(raw);
    const validIndices = decision.evidence.filter(index =>
      index >= 0 && index < evidence.messages.length && evidence.messages[index].addressedToBot);
    const uniqueIndices = [...new Set(validIndices)];
    const accepted = decision.decision === "add" &&
      decision.confidence >= 0.92 &&
      uniqueIndices.length >= 2;
    const selectedEvidence = uniqueIndices.map(index => evidence.messages[index].text);
    const result = {
      ok: accepted,
      reason: accepted ? "evidence-approved" : "evidence-rejected",
      decision,
      selectedEvidence,
      interactionCount: evidence.interactionCount,
      directCount: evidence.directCount,
    };
    pushDebugTrace({ stage: "friend:evaluated", memberNumber, senderName, ...result });
    return result;
  }

  async function evaluateAutoFriend(memberNumber, senderName, currentContent, options = {}) {
    if (!CONFIG.autoFriendEnabled && options.ignoreFeatureSwitch !== true) {
      return { ok: false, reason: "friend-disabled" };
    }
    const relationship = friendRelationshipStatus(memberNumber);
    if (!relationship.eligible) return { ok: false, ...relationship };
    const audit = loadFriendAudit();
    const previousReview = audit[relationship.memberNumber];
    if (previousReview?.status === "added") {
      return { ok: false, reason: "already-evaluated", memberNumber: relationship.memberNumber };
    }
    if (Number(previousReview?.nextReviewAt || 0) > Date.now()) {
      return {
        ok: false,
        reason: "friend-review-cooldown",
        memberNumber: relationship.memberNumber,
        nextReviewAt: Number(previousReview.nextReviewAt),
      };
    }
    const rateLimit = friendRateLimitStatus();
    if (!rateLimit.ready) return { ok: false, reason: "friend-rate-limit", rateLimit };
    const evidence = buildAutoFriendEvidence(memberNumber, currentContent);
    if (evidence.interactionCount < CONFIG.autoFriendMinInteractions ||
        evidence.directCount < CONFIG.autoFriendMinDirectMessages ||
        evidence.messages.length < CONFIG.autoFriendMinDirectMessages) {
      return { ok: false, reason: "insufficient-history", evidence };
    }
    const evaluation = await classifyFriendEvidence(memberNumber, senderName, evidence);
    // 证据不足时记录冷却，避免每条消息都重复调用审查模型；通过的候选
    // 由 addNativeFriend 在真正成功后写入 status=added。
    if (!evaluation.ok) {
      const now = Date.now();
      audit[relationship.memberNumber] = {
        status: "skipped",
        evaluatedAt: new Date(now).toISOString(),
        nextReviewAt: now + CONFIG.autoFriendReviewCooldownMs,
        name: relationship.name,
        reason: evaluation.decision?.reason || evaluation.reason || "evidence-rejected",
        evidence: evaluation.selectedEvidence || [],
      };
      saveFriendAudit(audit);
    }
    return evaluation;
  }

  async function maybeAutoFriend(memberNumber, senderName, currentContent, options = {}) {
    const mn = Number(memberNumber);
    if (state.autoFriendInFlight[mn]) {
      return { ok: false, reason: "friend-evaluation-in-flight", memberNumber: mn };
    }
    state.autoFriendInFlight[mn] = true;
    try {
      const evaluation = await evaluateAutoFriend(mn, senderName, currentContent);
      if (!evaluation.ok) return evaluation;
      return addNativeFriend(mn, {
        mode: "autonomous",
        reason: evaluation.decision.reason,
        evidence: evaluation.selectedEvidence,
      }, options);
    } finally {
      delete state.autoFriendInFlight[mn];
    }
  }

  function executeEmote(memberNumber, expression) {
    try {
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
      if (!char) return { ok: false, reason: "找不到玩家" };
      // 校验 expression 是否在允许列表内
      const group = AssetGroup.find(g => g?.Name === "Emoticon");
      const allowed = group?.AllowExpression || [];
      const expr = allowed.find(e => e.toLowerCase() === expression.toLowerCase());
      if (!expr) return { ok: false, reason: `未知表情: ${expression}` };
      CharacterSetFacialExpression(char, "Emoticon", expr);
      if (memberNumber === Player.MemberNumber) ChatRoomSyncExpression();
      updateCharacter(char);
      console.log(`[MisakaChat] EMOTE: #${memberNumber} -> ${expr}`);
      return { ok: true, msg: `表情改为 ${expr}` };
    } catch(e) {
      console.error("[MisakaChat] 表情设置失败:", e.message);
      return { ok: false, reason: e.message };
    }
  }

  function characterByMemberNumber(memberNumber) {
    const mn = Number(memberNumber);
    if (mn === Number(Player?.MemberNumber)) return Player;
    return (ChatRoomCharacter || []).find(c => Number(c.MemberNumber) === mn) || null;
  }

  function activityCandidateKey(candidate) {
    return [
      candidate?.activityName || "",
      candidate?.groupName || "",
      candidate?.itemAsset || "",
      candidate?.itemGroup || "",
    ].join("|");
  }

  function buildAllowedActivityCatalog(memberNumber) {
    const target = characterByMemberNumber(memberNumber);
    if (!target || typeof ActivityAllowedForGroup !== "function") return [];
    const groups = (AssetGroup || []).filter(group => group?.Family === target.AssetFamily);
    const seen = new Set();
    const catalog = [];
    for (const rawGroup of groups) {
      let allowed = [];
      try {
        allowed = ActivityAllowedForGroup(target, rawGroup.Name) || [];
      } catch (e) {
        pushDebugTrace({
          stage: "activity:catalog-error",
          memberNumber: Number(memberNumber),
          group: rawGroup.Name,
          reason: e.message,
        });
        continue;
      }
      for (const itemActivity of allowed) {
        const activity = itemActivity?.Activity;
        const groupName = String(itemActivity?.Group || rawGroup.Name || "");
        const group = ActivityGetGroupOrMirror?.(target.AssetFamily, groupName);
        if (!activity?.Name || !group?.Name) continue;
        let label = "";
        try {
          const tag = ActivityBuildChatTag(target, group, activity);
          label = String(ActivityDictionaryText(tag) || tag)
            .replaceAll("SourceCharacter", "御坂")
            .replaceAll("TargetCharacter", target.Nickname || target.Name || `#${target.MemberNumber}`);
        } catch (e) {}
        const candidate = {
          activityName: String(activity.Name),
          groupName: String(group.Name),
          itemAsset: String(itemActivity?.Item?.Asset?.Name || ""),
          itemGroup: String(itemActivity?.Item?.Asset?.Group?.Name || ""),
          label: label.slice(0, 160),
          itemActivity,
        };
        const key = activityCandidateKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        catalog.push(candidate);
      }
    }
    return catalog;
  }

  function compactActivityCatalog(catalog) {
    return (catalog || []).map((candidate, index) => {
      const item = candidate.itemAsset
        ? `｜道具 ${candidate.itemGroup}:${candidate.itemAsset}`
        : "";
      return `${index}. ${candidate.activityName}@${candidate.groupName}${item}｜${candidate.label || "无本地描述"}`;
    }).join("\n");
  }

  function parseActivitySelection(raw) {
    const jsonText = String(raw || "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    try {
      const parsed = JSON.parse(jsonText);
      const index = Number(parsed?.index);
      if (!Number.isInteger(index) || index < 0) return null;
      return { index, reason: String(parsed?.reason || "").trim().slice(0, 160) };
    } catch (e) {
      return null;
    }
  }

  async function resolvePlannedActivity(plan, senderName, content) {
    const targetNumber = Number(plan?.activity?.target);
    const target = characterByMemberNumber(targetNumber);
    if (!target) return { ok: false, reason: "target-not-in-room", targetNumber };
    const catalog = buildAllowedActivityCatalog(targetNumber);
    pushDebugTrace({
      stage: "activity:catalog",
      target: targetNumber,
      count: catalog.length,
      request: plan?.activity?.request || plan?.goal || content,
    });
    if (catalog.length === 0) return { ok: false, reason: "no-native-activity", targetNumber };

    const request = String(plan?.activity?.request || plan?.goal || content || "").trim();
    const system = `你是 BC 原生 Activity 选择器。只输出严格 JSON：{"index":候选编号,"reason":"选择理由"}。
从动态允许目录中选择最符合用户原意的一项。目录已经通过 BC 原生距离、区域、姿势、道具前置和双方偏好权限检查。
必须遵守：
1. 只选择目录中的编号，不得发明 Activity、部位或道具。
2. 保留动作对象和身体部位；“摸头”不能改成摸胸，“亲脸/亲嘴”不能改成亲腿。
3. 用户未指定身体部位时，选择最日常、最少冒犯的可用部位；不得自行升级为私密部位。
4. 用户明确要求假装、躲藏、表演或文字动作描写时不应进入本选择器；若已经进入，只选择与请求直接相符的原生动作。
5. 若没有语义相符项，输出 {"index":-1,"reason":"no-match"}。`;
    const user = `说话者：${senderName}\n原始请求：${content}\n规划目标：${request}\n目标：${target.Nickname || target.Name}#${targetNumber}\n允许目录：\n${compactActivityCatalog(catalog)}`;
    const raw = await callLLM(system, [{ role: "user", content: user }], {
      thinking: false,
      temperature: 0,
      maxTokens: 160,
    });
    const selected = parseActivitySelection(raw);
    if (!selected || selected.index >= catalog.length) {
      return { ok: false, reason: "resolver-no-match", targetNumber, catalogCount: catalog.length };
    }
    const candidate = catalog[selected.index];
    const result = {
      ok: true,
      targetNumber,
      targetName: target.Nickname || target.Name || `#${targetNumber}`,
      key: activityCandidateKey(candidate),
      activityName: candidate.activityName,
      groupName: candidate.groupName,
      itemAsset: candidate.itemAsset,
      itemGroup: candidate.itemGroup,
      label: candidate.label,
      reason: selected.reason,
    };
    pushDebugTrace({ stage: "activity:resolved", ...result });
    return result;
  }

  function findAllowedActivitySelection(selection) {
    const target = characterByMemberNumber(selection?.targetNumber);
    if (!target) return null;
    return buildAllowedActivityCatalog(selection.targetNumber)
      .find(candidate => activityCandidateKey(candidate) === selection.key) || null;
  }

  function activityCooldownStatus(targetNumber) {
    const now = Date.now();
    const globalRemaining = CONFIG.activityCooldownMs - (now - state.lastActivityTime);
    const targetRemaining = CONFIG.activityPerTargetCooldownMs -
      (now - (state.lastActivityByTarget[targetNumber] || 0));
    const remainingMs = Math.max(globalRemaining, targetRemaining, 0);
    return { ready: remainingMs <= 0, remainingMs };
  }

  function shouldFallbackActivityToRoleplay(reason) {
    return ["no-native-activity", "resolver-no-match", "activity-no-longer-allowed"]
      .includes(String(reason || ""));
  }

  function executeNativeActivity(selection, options = {}) {
    const dryRun = options.dryRun === true;
    if (!CONFIG.activityEnabled) return { ok: false, reason: "activity-disabled" };
    const target = characterByMemberNumber(selection?.targetNumber);
    if (!target) return { ok: false, reason: "target-not-in-room" };
    const cooldown = activityCooldownStatus(selection.targetNumber);
    if (!cooldown.ready) return { ok: false, reason: "activity-cooldown", remainingMs: cooldown.remainingMs };

    // 执行前重新读取原生允许目录。角色姿势、距离、权限或道具状态可能在
    // 规划后已经变化；旧候选绝不能绕过 BC 当下的校验。
    const candidate = findAllowedActivitySelection(selection);
    if (!candidate) return { ok: false, reason: "activity-no-longer-allowed" };
    const targetGroup = ActivityGetGroupOrMirror?.(target.AssetFamily, candidate.groupName);
    if (!targetGroup || typeof ActivityRun !== "function") {
      return { ok: false, reason: "activity-api-unavailable" };
    }
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        targetNumber: Number(target.MemberNumber),
        activityName: candidate.activityName,
        groupName: candidate.groupName,
        itemAsset: candidate.itemAsset,
      };
    }
    try {
      ActivityRun(Player, target, targetGroup, candidate.itemActivity, true);
      const now = Date.now();
      state.lastActivityTime = now;
      state.lastActivityByTarget[selection.targetNumber] = now;
      const result = {
        ok: true,
        targetNumber: Number(target.MemberNumber),
        targetName: target.Nickname || target.Name || `#${target.MemberNumber}`,
        activityName: candidate.activityName,
        groupName: candidate.groupName,
        itemAsset: candidate.itemAsset,
        label: candidate.label,
      };
      pushDebugTrace({ stage: "activity:executed", ...result });
      return result;
    } catch (e) {
      pushDebugTrace({
        stage: "activity:execute-failed",
        target: selection.targetNumber,
        activityName: candidate.activityName,
        groupName: candidate.groupName,
        reason: e.message,
      });
      return { ok: false, reason: e.message || "activity-run-failed" };
    }
  }

  // Tool Policy: 检测危险操作,通知玩家但不拦截
  function checkToolPolicy(cmd) {
    // 对真人的道具操作和移动视为危险操作
    const selfMn = Player?.MemberNumber;
    // EMOTE: 无危险,直接放行
    if (cmd.type === "emote") return { ok: true, dangerous: false };
    // 普通手持物（食物、饮料、小玩具）不属于束缚或人物控制；频繁警告只会
    // 淹没真正重要的真人移动、拘束、快照恢复等提示。
    if (["itemadd", "itemdel", "itemset", "itemcolor"].includes(cmd.type)) {
      const mapping = findItemAsset(cmd.item, actionTargetCharacter(cmd.memberNumber));
      if (mapping?.group === "ItemHandheld") return { ok: true, dangerous: false };
    }
    // COPY: 检查源和目标
    if (cmd.type === "copyRestraint") {
      const targets = [];
      for (const mn of [cmd.sourceNumber, cmd.targetNumber]) {
        if (mn === selfMn) continue;
        const c = ChatRoomCharacter.find(ch => ch.MemberNumber === mn);
        const isGimp = !!(c && (c.Nickname || c.Name || "").startsWith("GIMP "));
        if (!isGimp) targets.push(c?.Nickname || c?.Name || ("#" + mn));
      }
      if (targets.length > 0) return { ok: true, dangerous: true, target: targets.join(" → ") };
      return { ok: true, dangerous: false };
    }
    // SNAPSHOT: 检查目标
    if (cmd.type === "snapshotSave" || cmd.type === "snapshotRestore") {
      if (cmd.memberNumber === selfMn) return { ok: true, dangerous: false };
      const c = ChatRoomCharacter.find(ch => ch.MemberNumber === cmd.memberNumber);
      const isGimp = !!(c && (c.Nickname || c.Name || "").startsWith("GIMP "));
      if (!isGimp) return { ok: true, dangerous: true, target: c?.Nickname || c?.Name || ("#" + cmd.memberNumber) };
      return { ok: true, dangerous: false };
    }
    if (cmd.memberNumber === selfMn) return { ok: true, dangerous: false };
    // 检查目标是否为真人(不是 GIMP 娃娃)
    const c = ChatRoomCharacter.find(ch => ch.MemberNumber === cmd.memberNumber);
    const isGimp = !!(c && (c.Nickname || c.Name || "").startsWith("GIMP "));
    if (!isGimp) {
      return { ok: true, dangerous: true, target: c?.Nickname || c?.Name || ("#" + cmd.memberNumber) };
    }
    return { ok: true, dangerous: false };
  }

  async function executeCommands(commands) {
    let moveOk = true, itemOk = true;
    const failures = [];

    const record = (cmd, result) => {
      const ok = (result && typeof result === "object" && "ok" in result) ? !!result.ok : !!result;
      if (!ok) failures.push({ cmd, reason: result?.reason || "failed" });
      return ok;
    };

    // parseActionCommands 已保留模型原始顺序；执行器不得再次按类型排序。
    for (const cmd of commands) {
      if (cmd.type === "memsearch" || cmd.type === "bcequery") continue;
      const policy = checkToolPolicy(cmd);
      if (policy.dangerous) {
        const who = policy.target;
        const actionDesc = { move:"移动", moveTo:"移动", moveEdge:"移动", itemadd:"添加道具", itemdel:"移除道具", itemdelall:"解除全部", itemcolor:"改色", itemset:"设置属性", snapshotSave:"保存快照", snapshotRestore:"恢复快照", copyRestraint:"复制束缚", emote:"设置表情" }[cmd.type] || cmd.type;
        sendLocal(`⚠️ 即将执行真人操作 | 对象：${who} | 操作：${actionDesc}`);
        console.warn(`[MisakaChat] 危险操作通知: ${cmd.type} -> ${who}`);
      }
      if (cmd.type === "move") {
        moveOk = record(cmd, executeMove(cmd.memberNumber, cmd.direction)) && moveOk;
      } else if (cmd.type === "moveTo") {
        moveOk = record(cmd, await executeMoveTo(cmd.memberNumber, cmd.targetNumber, cmd.side)) && moveOk;
      } else if (cmd.type === "moveEdge") {
        moveOk = record(cmd, await executeMoveEdge(cmd.memberNumber, cmd.edge)) && moveOk;
      } else if (cmd.type === "itemadd") {
        itemOk = record(cmd, executeItemAdd(cmd.memberNumber, cmd.item, cmd.part, cmd.color)) && itemOk;
      } else if (cmd.type === "itemset") {
        itemOk = record(cmd, executeItemSet(cmd.memberNumber, cmd.item, cmd.part, cmd.property, cmd.value)) && itemOk;
      } else if (cmd.type === "itemcolor") {
        itemOk = record(cmd, executeItemColor(cmd.memberNumber, cmd.item, cmd.part, cmd.color)) && itemOk;
      } else if (cmd.type === "itemdel") {
        console.log(`[MisakaChat] CMD itemdel #${cmd.memberNumber} item="${cmd.item}" part="${cmd.part||""}"`);
        itemOk = record(cmd, executeItemDel(cmd.memberNumber, cmd.item, cmd.part)) && itemOk;
      } else if (cmd.type === "itemdelall") {
        console.log(`[MisakaChat] CMD itemdelall #${cmd.memberNumber}`);
        itemOk = record(cmd, executeItemDelAll(cmd.memberNumber)) && itemOk;
      } else if (cmd.type === "snapshotSave") {
        console.log(`[MisakaChat] CMD snapshotSave #${cmd.memberNumber}`);
        itemOk = record(cmd, executeSnapshotSave(cmd.memberNumber)) && itemOk;
      } else if (cmd.type === "snapshotRestore") {
        console.log(`[MisakaChat] CMD snapshotRestore #${cmd.memberNumber}`);
        itemOk = record(cmd, executeSnapshotRestore(cmd.memberNumber)) && itemOk;
      } else if (cmd.type === "copyRestraint") {
        console.log(`[MisakaChat] CMD copy #${cmd.sourceNumber} -> #${cmd.targetNumber}`);
        itemOk = record(cmd, executeCopyRestraint(cmd.sourceNumber, cmd.targetNumber)) && itemOk;
      } else if (cmd.type === "emote") {
        console.log(`[MisakaChat] CMD emote #${cmd.memberNumber} -> ${cmd.expression}`);
        itemOk = record(cmd, executeEmote(cmd.memberNumber, cmd.expression)) && itemOk;
      }
    }
    // 子指令各自成功不代表复合操作的最终结果正确。尤其“删旧→加新→调属性”
    // 必须确认最后要求保留的道具仍然存在，要求删除的道具确实已消失。
    const finalExpectations = new Map();
    for (const cmd of commands) {
      if (!["itemadd", "itemdel", "itemset", "itemcolor"].includes(cmd.type)) continue;
      const key = `${cmd.memberNumber}:${cmd.item}:${cmd.part || ""}`;
      finalExpectations.set(key, cmd);
    }
    for (const cmd of finalExpectations.values()) {
      const char = cmd.memberNumber === Player?.MemberNumber
        ? Player
        : (ChatRoomCharacter || []).find(c => Number(c.MemberNumber) === Number(cmd.memberNumber));
      if (!char) continue; // 单条执行时已记录 missing-character。
      const present = !!findItemByPart(char, cmd.item, cmd.part);
      const shouldExist = cmd.type !== "itemdel";
      if (present !== shouldExist) {
        const reason = shouldExist ? "final-item-missing" : "final-item-still-present";
        if (!failures.some(f => f.cmd === cmd && f.reason === reason)) failures.push({ cmd, reason });
        itemOk = false;
      }
    }
    return { moveOk, itemOk, failures };
  }

  function displayNameByMemberNumber(memberNumber) {
    const char = (memberNumber === Player?.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
    return (char?.Nickname || char?.Name || ("#" + memberNumber));
  }

  // === [Chat] 消息处理 ===
  function onChatRoomMessage(data) {
    if (!isCurrent() || !CONFIG.enabled) return;
    if (typeof Player === "undefined" || !Player) return;

    const content = data.Content || "";
    const senderNum = data.Sender;

    // 进出检测(在 validTypes 之前)
    if (data.Type === "Action" && ["ServerEnter","ServerDisconnect","ServerLeave"].includes(data.Content)) {
      let who = "";
      let whoNum = 0;
      if (data.Dictionary?.length) {
        const ne = data.Dictionary.find(d => d.Tag === "SourceCharacter");
        if (ne) { who = ne.Text || ""; whoNum = ne.MemberNumber || 0; }
      }
      if (!who) return;
      const action = data.Content === "ServerEnter" ? "进入" : "离开";
      const t = new Date();
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      state.roomLog.push({ time: Date.now(), text: `${hh}:${mm} ${who}${whoNum ? `#${whoNum}` : ""} ${action}` });
      if (state.roomLog.length > 30) state.roomLog.shift();
      return;
    }

    const validTypes = ["Chat","Talk","Emote","Whisper","Activity","Action"];
    if (!validTypes.includes(data.Type)) return;

    // === [Chat] 垃圾消息过滤 ===
    const NOISE_PATTERNS = [
      /^TriggerShock[12]$/i,
      /^Beep$/i,
      /^OrgasmFailSurrender\d*$/i,
      /^Orgasm\d*$/i,
      /^ActionActivateSafewordRelease$/i,
      /^ChatSelf-ItemMouth-MoanGag(Giggle)?$/i,
    ];
    function isNoise(type, rawContent, senderName) {
      // GIMP 娃娃只过滤自动消息类型(Activity/Emote/Action),保留 Chat/Talk/Whisper(可能是真人)
      if (senderName && senderName.startsWith("GIMP ")) {
        return type === "Activity" || type === "Emote" || type === "Action" ||
               NOISE_PATTERNS.some(pat => pat.test(rawContent));
      }
      for (const pat of NOISE_PATTERNS) {
        if (pat.test(rawContent)) return true;
      }
      return false;
    }

    // Activity/Emote 转可读文字
    let readableContent = content;
    if (data.Type === "Activity" || data.Type === "Emote") {
      let targetName = "";
      const tc = data.Dictionary?.find(d => d.Tag === "TargetCharacter" || d.Tag === "DestinationCharacter");
      if (tc?.Text) targetName = tc.Text;
      const partMap = {Mouth:"嘴",Nose:"鼻子",Ears:"耳朵",Feet:"脚",Legs:"腿",Arms:"手臂",Hands:"手",Neck:"脖子",Torso:"身体",Breasts:"胸",Nipples:"乳头",Clit:"明蒂",Vulva:"下体",Penis:"阴茎",Butt:"屁股"};
      const actionMap = {Pet:"摸了摸",Spank:"拍了拍",Slap:"打了一下",Tickle:"挠了挠",Rub:"揉了揉",Kiss:"亲了亲",Lick:"舔了舔",Bite:"咬了一口",Suck:"吸了吸",Pinch:"捏了捏",Grab:"抓住",MoanGag:"被口塞住呻吟",Orgasm:"高潮了"};
      readableContent = content
        .replace(/^Chat(?:Other|Self)-Item([A-Za-z]+)-([A-Za-z]+)$/, (_, p, a) => {
          const action = actionMap[a] || a, part = partMap[p] || p;
          return targetName ? `${action}${targetName}的${part}` : `${action}${part}`;
        })
        .replace(/^Orgasm(\d+)?$/, (_, n) => n ? `高潮了(${n})` : "高潮了")
        .replace(/^OrgasmFailSurrender(\d+)?$/, () => "高潮失败了");
    }

    const key = senderNum + ":" + content + ":" + data.Type;
    const now = Date.now();
    if (window.__misakaLastKey === key && now - (window.__misakaLastKeyTime || 0) < 10000) return;
    window.__misakaLastKey = key;
    window.__misakaLastKeyTime = now;

    if (senderNum === Player.MemberNumber) {
      state.recentMessages.push({ senderName: "御搬", content: readableContent, isSelf: true, time: now });
      if (state.recentMessages.length > CONFIG.maxContext) state.recentMessages.shift();
      // 御坂自己的消息也存语义记忆
      if (readableContent.length >= 15 && !["Activity", "Action"].includes(data.Type)) {
        storeSemanticMemory(`御搬: ${readableContent}`, { sender: "御搬", memberNum: Player.MemberNumber, isSelf: true, messageType: data.Type }).catch(() => {});
      }
      return;
    }

    const senderChar = ChatRoomCharacter.find(c => c.MemberNumber === senderNum);
    const senderName = (senderChar?.Nickname || senderChar?.Name) || ("#" + senderNum);
    // 判断是否为垃圾消息
    const noise = isNoise(data.Type, content, senderName);


    // 垃圾消息:不进上下文、不推动 messageCount
    if (noise) return;

    // 先标记是否直接对御坂说话。此类消息仍保留为上下文，但不应在未来
    // 作为“过去事实”的主证据参与向量召回。
    const triggers = ["misaka","御搬","御坂","misaki的","搬运工"];
    const lower = content.toLowerCase();
    const readableLower = readableContent.toLowerCase();
    const triggered = triggers.some(t => lower.includes(t.toLowerCase()) || readableLower.includes(t.toLowerCase()));

    const durableConversation = !["Activity", "Action"].includes(data.Type);
    if (durableConversation) updateProfile(senderNum, senderName, readableContent);
    state.recentMessages.push({ senderName: senderName, content: readableContent, senderMemberNumber: senderNum, isSelf: false, time: now });
    if (state.recentMessages.length > CONFIG.maxContext) state.recentMessages.shift();
    state.lastNonSelfMsgTime = now;

    // 所有非噪音消息都存语义记忆(不只是触发回复的)
    if (readableContent.length >= 15 && durableConversation) {
      storeSemanticMemory(`${senderName}: ${readableContent}`, {
        sender: senderName,
        memberNum: senderNum,
        messageType: data.Type,
        addressedToBot: triggered,
      }).catch(() => {});
    }

    if (durableConversation) {
      state.messageCount++;
      try { localStorage.setItem("misaka_msg_count", String(state.messageCount)); } catch(e) {}
    }


    // 触发长期记忆提炼
    if (durableConversation && state.messageCount % CONFIG.memoryRefineInterval === 0) {
      maybeRefineMemory().catch(e => console.warn("[MisakaChat] refine error:", e.message));
    }


    if (!triggered) return;
    if (state.busy || window.__misakaGlobalBusy || window.__misakaReplyInProgress) return;

    const nowTime = Date.now();
    if (nowTime - state.lastReplyTime < CONFIG.cooldownMs) return;
    const lastUserTime = state.lastUserReplyTime[senderNum] || 0;
    if (nowTime - lastUserTime < CONFIG.perUserCooldownMs) return;

    window.__misakaGlobalBusy = true;
    window.__misakaReplyInProgress = true;

    const replyTimeout = trackedTimeout(() => {
      console.error("[MisakaChat] 回复硬超时");
      state.busy = false;
      window.__misakaGlobalBusy = false;
      window.__misakaReplyInProgress = false;
    }, CONFIG.replyHardTimeoutMs);

    handleReply(senderNum, senderName, readableContent).finally(() => clearTrackedTimeout(replyTimeout));
  }

  // === [BCE] 玩家档案查询 ===




  async function queryProfile(nameOrId) {
    return new Promise((resolve) => {
      const req = indexedDB.open("bce-past-profiles");
      req.onsuccess = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("profiles")) { resolve(null); return; }
        const tx = db.transaction("profiles","readonly");
        const allReq = tx.objectStore("profiles").getAll();
        allReq.onsuccess = () => {
          const data = allReq.result || [];
          const q = String(nameOrId||"").toLowerCase().trim();
          const matches = data.filter(d => {
            const mn = d.memberNumber ? d.memberNumber.toString() : "";
            return (d.name && d.name.toLowerCase().includes(q)) ||
                   (d.lastNick && d.lastNick.toLowerCase().includes(q)) ||
                   mn === q;
          });
          if (matches.length === 0) { resolve(null); return; }
          matches.sort((a,b) => ((b.seen||0)-(a.seen||0)));
          resolve(matches.slice(0,3).map(d => {
            const info = { name: d.name, lastNick: d.lastNick||"", memberNumber: d.memberNumber, seen: d.seen ? new Date(d.seen).toLocaleString("zh-CN") : "未知" };
            if (d.characterBundle) {
              try {
                const b = typeof d.characterBundle === "string" ? JSON.parse(d.characterBundle) : d.characterBundle;
                info.nickname = b.Nickname || "";
                info.owner = b.Ownership?.Name ? `${b.Ownership.Name} (#${b.Ownership.MemberNumber})` : "无";
                info.lovers = Array.isArray(b.Lovership) ? b.Lovership.map(l => `${l.Name}${l.Stage===2?"(正式)":""}`).join(", ") : "无";
                // 描述处理:BCE 缓存中未见过的玩家描述会是乱码,这是正常的
                const rawDesc = (b.Description || "").slice(0, 200);
                info.description = rawDesc;
                const normalChars = (rawDesc.match(/[\u0020-\u007e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\n\r\t]/g) || []).length;
                if (rawDesc.length > 0 && normalChars / rawDesc.length < 0.7) {
                  info.descNote = "(描述是乱码,因为没见过这个玩家,BCE 缓存里只有损坏的数据,这是正常的)";
                } else {
                  info.descNote = "";
                }
                if (Array.isArray(b.Appearance)) {
                  let lc=0, ic=0;
                  for (const a of b.Appearance) { if (a.Asset?.Group?.Name?.startsWith("Item")) ic++; if (a.Property?.LockedBy) lc++; }
                  info.itemCount = ic; info.lockCount = lc;
                }
              } catch(e) {}
            }
            return info;
          }));
        };
        allReq.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  }

  // 检测明确的档案查询请求(只在很明确的场景触发 BCE 查询)

function unescapeHTML(s) {
    return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
  }

  function graphemes(text) {
    const value = String(text || "");
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      return [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value)]
        .map(part => part.segment);
    }
    return Array.from(value);
  }

  function truncateNatural(text, maxGraphemes) {
    const units = graphemes(text);
    if (units.length <= maxGraphemes) return text;
    const prefix = units.slice(0, maxGraphemes).join("").trimEnd();
    const minimumBoundary = Math.floor(maxGraphemes * 0.55);
    let boundary = -1;
    for (const match of prefix.matchAll(/[。！？!?…~～；;](?=\s|$|[^”’」』）】])/g)) {
      boundary = match.index + match[0].length;
    }
    if (boundary >= minimumBoundary) return prefix.slice(0, boundary).trimEnd();
    return `${graphemes(prefix).slice(0, Math.max(1, maxGraphemes - 1)).join("").trimEnd()}…`;
  }

  function stripBalancedOuterQuotes(text) {
    const value = String(text || "").trim();
    const pairs = new Map([['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"]]);
    const expected = pairs.get(value[0]);
    return expected && value.endsWith(expected) ? value.slice(1, -1).trim() : value;
  }

  function sanitizeReplyField(value, kind) {
    let cleaned = unescapeHTML(stripBalancedOuterQuotes(value))
      .replace(/^(御[搬坂]|Misaka|misaka)\s*[::]\s*/i, "")
      .replace(/\s*\n+\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    cleaned = cleaned.replace(/^\*+|\*+$/g, "").trim();
    if (!cleaned) return "";
    return truncateNatural(
      cleaned,
      kind === "action" ? VISIBLE_ACTION_MAX_GRAPHEMES : VISIBLE_SPEECH_MAX_GRAPHEMES,
    );
  }

  function formatStructuredVisibleReply(action, speech) {
    const cleanAction = sanitizeReplyField(action, "action");
    const cleanSpeech = sanitizeReplyField(speech, "speech");
    return [
      cleanAction ? `*${cleanAction}*` : "",
      cleanSpeech,
    ].filter(Boolean).join("\n");
  }

  function sanitizeReply(reply) {
    let cleaned = stripBalancedOuterQuotes(reply);

    // thinking 模式下思考过程在 reasoning_content 里,content 是干净的回复
    // 这里只为旧文本协议做兼容；新协议使用 action/speech 独立字段，不经过
    // “取前两行再切 120 字符”的有损链路。
    let lines = cleaned.split(/\n+/).map(l => l.trim().replace(/^(御[搬坂]|Misaka|misaka)\s*[::]\s*/i, "").trim()).filter(Boolean);
    // 最多取前两行(动作 + 说话)
    lines = lines.slice(0, 2);
    // 兼容旧 | 格式:如果单行包含 |,拆成多行
    lines = lines.flatMap(l => l.split(/\|/).map(s => s.trim()).filter(Boolean));
    lines = lines.slice(0, 2);
    // 清理每行:奇数 * 时去掉末尾孤立 *
    lines = lines.map(l => {
      const stars = (l.match(/\*/g) || []).length;
      if (stars % 2 !== 0) l = l.replace(/\*+$/, '');
      return l.trim();
    }).filter(Boolean);
    cleaned = lines.join('\n');

    return unescapeHTML(cleaned);
  }

  function normalizeRoleplayReply(reply) {
    const cleaned = sanitizeReply(reply);
    if (!cleaned) return "";
    const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 2);
    if (lines.some(line => /^\*[^*\n]+\*$/.test(line))) return lines.join("\n");
    // roleplay 已由规划器确认是“不改变游戏状态的动作”。因此模型漏写星号时，
    // 可以按意图确定性补格式，而不需要再用动作关键词猜一句话是不是动作。
    const action = lines[0].replace(/^\*+|\*+$/g, "").trim();
    const speech = lines[1] ? lines[1].replace(/^\*+|\*+$/g, "").trim() : "";
    return [`*${action}*`, speech].filter(Boolean).join("\n");
  }

  function looksLikeBareActionLine(line) {
    const text = String(line || "").replace(/^\*+|\*+$/g, "").trim();
    if (!text || text.length > 36 || /[?？!！]$/.test(text)) return false;
    if (/^(?:轻轻|微微|慢慢|悄悄|下意识地|忍不住|有些|故意|假装)?(?:歪(?:了)?歪头|歪(?:着)?头|偏(?:了)?偏头|偏头|点(?:了)?点头|点头|摇(?:了)?摇头|摇头|低(?:下)?头|抬(?:起)?头|别过头|转过头|探头|耸(?:了)?耸肩|耸肩|摆(?:了)?摆手|摆手|挥(?:了)?挥手|挥手|摊(?:了)?摊手|摊手|拍(?:了)?拍(?:手|脑袋|额头)|揉(?:了)?揉(?:眼睛|鼻子|头发|脑袋)|眨(?:了)?眨眼|眨眼|闭(?:上)?眼|睁(?:开)?眼|撇(?:了)?撇嘴|鼓(?:了)?鼓脸|跺(?:了)?跺脚|叹(?:了)?口气|叹气|轻笑|笑(?:了)?笑|哼(?:了)?一声|做(?:了)?个.+表情|露出.+表情|站直|坐直|缩(?:了)?缩(?:脖子|身体)|退(?:了)?一步|靠(?:近|过去)|凑(?:近|过去)|(?:脸|脸颊|耳根).{0,10}(?:一红|泛红|发红|红起来))/.test(text)) {
      return true;
    }
    const hasBodyCue = /(?:眼神|目光|视线|表情|脸|脸颊|耳根|嘴角|眉头|肩膀?|双手|手指|脑袋|头|身体|姿势)/.test(text);
    const hasActionCue = /(?:警惕|失焦|发红|脸红|一红|泛红|红起来|移开|躲开|垂下|抬起|交叠|抱起|抱住|攥紧|松开|僵住|颤(?:了|抖|一下)|抖(?:了|一下)|歪|偏|低|抬|摇|点|摆|挥|耸|揉|拍|别过(?:头)?(?:去)?|转过(?:头)?|露出|变得|起来|下去|过去)$/.test(text);
    return hasBodyCue && hasActionCue;
  }

  function normalizeVisibleReply(intent, reply) {
    const cleaned = sanitizeReply(reply);
    if (!cleaned) return "";
    if (intent === "roleplay") return normalizeRoleplayReply(cleaned);
    const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 2);
    if (lines.length === 0 || /^\*[^*\n]+\*$/.test(lines[0])) return lines.join("\n");
    if (!looksLikeBareActionLine(lines[0])) return lines.join("\n");
    const action = lines[0].replace(/^\*+|\*+$/g, "").trim();
    return [`*${action}*`, ...lines.slice(1)].join("\n");
  }

  function parseAssistantReply(reply, intent = "chat") {
    const structured = parseStructuredReply(reply);
    if (structured.matched) {
      if (!structured.ok) {
        return {
          commands: [],
          cleaned: "刚才没组织好，再说一次吧。",
          structured: true,
          protocolError: structured.reason,
          rejectedCommands: [],
        };
      }
      const protocolMismatch = structured.protocol &&
        structured.protocol !== STRUCTURED_REPLY_PROTOCOL;
      const commandEnvelopeInvalid = structured.rejectedCommands.length > 0;
      return {
        // 结构化 commands 是一个原子操作计划。任一对象格式错误时不能执行
        // 剩余合法子集，否则复合请求会留下半成品；action 分支会因此进入
        // 已有的“无可执行指令”纠错流程。
        commands: protocolMismatch || commandEnvelopeInvalid ? [] : structured.commands,
        cleaned: formatStructuredVisibleReply(structured.action, structured.speech),
        structured: true,
        protocol: structured.protocol,
        protocolError: protocolMismatch
          ? "unsupported-protocol"
          : (commandEnvelopeInvalid ? "invalid-command-envelope" : ""),
        rejectedCommands: structured.rejectedCommands,
      };
    }
    const legacy = parseActionCommands(reply);
    return {
      commands: legacy.commands,
      cleaned: normalizeVisibleReply(intent, legacy.cleaned),
      structured: false,
      protocol: "legacy-text",
      protocolError: "",
      rejectedCommands: [],
    };
  }

  async function dryRunStructuredReplyForTest(intent, content) {
    const safeIntent = ["chat", "roleplay", "action"].includes(intent) ? intent : "chat";
    const systemPrompt = getSystemPrompt(false) +
      `\n\n【本轮测试计划】intent=${safeIntent}。这是只读协议测试，只验证序列化结果，任何 commands 都不会执行。` +
      `\n\n${structuredReplyInstruction()}`;
    const raw = await callLLM(systemPrompt, [{
      role: "user",
      content: `【当前必须处理的最新消息】测试者#0: ${String(content || "向我打个招呼").slice(0, 300)}`,
    }], {
      thinking: true,
      temperature: 0,
      maxTokens: 2048,
      json: true,
    });
    return {
      raw,
      parsed: parseAssistantReply(raw, safeIntent),
    };
  }

  async function dryRunEmptyContentRecoveryForTest() {
    return callLLM(
      "你是结构化回复测试器，只输出指定 JSON。",
      [{ role: "user", content: "请回复一条非空测试消息。" }],
      {
        thinking: true,
        temperature: 0,
        maxTokens: 256,
        json: true,
      },
    );
  }

  async function dryRunCallBurstForTest(count = 31) {
    const outputs = [];
    const runs = Math.max(1, Math.min(40, Number(count) || 31));
    for (let index = 0; index < runs; index++) {
      outputs.push(await callLLM(
        "你是本地限流边界测试器，只输出指定 JSON。",
        [{ role: "user", content: `第${index + 1}次调用` }],
        { thinking: false, temperature: 0, maxTokens: 64, json: true },
      ));
    }
    return outputs;
  }

  async function renderClarification(question) {
    const fallback = sanitizeReply(question || "我还没弄明白，能再说清楚一点吗？");
    const prompt = getSystemPrompt(false) +
      "\n\n【当前任务】把下面的追问信息改写成一句简短、自然、符合御坂口吻的问题。" +
      "不执行操作，不写技术说明，不自称客服。" +
      `\n\n${structuredReplyInstruction()}`;
    const reply = await callLLM(prompt, [{ role: "user", content: `需要确认的信息:${fallback}` }], {
      thinking: false,
      maxTokens: 256,
      json: true,
    });
    if (!reply) return fallback;
    const parsed = parseAssistantReply(reply, "chat");
    if (parsed.commands.some(c => !["memsearch", "bcequery"].includes(c.type))) return fallback;
    return parsed.cleaned || fallback;
  }

  function buildMainReplySystemPrompt(requestPlan) {
    const needCatalog = requestPlan.intent === "action" && !!requestPlan.needsCatalog;
    const currentAppearanceFacts = buildCurrentAppearanceFacts(requestPlan);
    return getSystemPrompt(needCatalog) +
      `\n\n【本轮结构化操作计划】\n${JSON.stringify(requestPlan)}\n` +
      `${currentAppearanceFacts ? `\n${currentAppearanceFacts}\n` : ""}` +
      `必须以 goal 的最终状态和 constraints 为准。当前实时 Appearance 高于历史对话；不得根据历史声称某道具现在仍存在。` +
      `operations 是意图提示与操作边界，不是逐字段审查白名单。你可以在同一目标和操作大类内选择完成 goal 所需的 ADD/SET/DEL、精确 Asset 与实际部位。` +
      `operations.assets 若非空，优先使用规划器从目录解析出的 Asset；只有完整实时目录明确证明它不合适时才改用更准确的 Asset。` +
      `MOVE 只改变聊天室人物横向站位，绝不能表示进入、躺进、关进或使用设备；这类目标必须通过 ItemDevices 的 ITEMADD/ITEMDEL/ITEMSET 达成。` +
      `ITEMSET 的值必须来自该道具在目标 group 的精确清单，绝不能把 Arms 的样式套到 Legs/Feet。LeatherDeluxeCuffs 只能放 Arms。命名姿势必须真正设置对应样式，不能只加普通绳索或夹带口塞来冒充。` +
      `不得改变计划目标人物或跨越操作大类；不得自行夹带移动、表情或其他无关操作。复合操作必须按真实执行顺序输出（例如替换必须先移除再添加，随后才能设置属性）。` +
      `intent=roleplay 时只在 action 字段写动作描写，commands 必须为空；intent=chat 时只聊天，commands 必须为空。` +
      `\n\n${structuredReplyInstruction()}`;
  }

  async function dryRunPlannedRequestForTest(senderNum, senderName, content) {
    const requestPlan = await planUserRequest(senderNum, senderName, content, null);
    if (requestPlan?.intent !== "action") {
      return { requestPlan, raw: null, parsed: null, filtered: null, resolutions: [] };
    }
    const systemPrompt = buildMainReplySystemPrompt(requestPlan);
    const raw = await callLLM(systemPrompt, [{
      role: "user",
      content: `【当前必须处理的最新消息】${senderName}#${senderNum}: ${content}\n只回复并执行这一条。历史消息只作上下文,不要补做旧请求。`,
    }], {
      thinking: true,
      temperature: 0,
      maxTokens: 2048,
      json: true,
    });
    const parsed = parseAssistantReply(raw || "", requestPlan.intent);
    const filtered = filterCommandsByPlan(requestPlan, parsed.commands);
    const resolutions = filtered.allowed
      .filter(command => command.type === "itemadd")
      .map(command => {
        const char = actionTargetCharacter(command.memberNumber);
        const resolved = resolveItemAddTarget(char, command.item, command.part);
        return {
          command,
          resolved: resolved.ok
            ? {
                ok: true,
                group: resolved.group,
                asset: resolved.asset,
                partKind: resolved.partKind,
              }
            : resolved,
        };
      });
    return { requestPlan, raw, parsed, filtered, resolutions };
  }

  // 黑箱抽样入口：复用正式规划器、记忆回答器、Activity 选择器和主回复模型，
  // 但不发送消息、不执行 Activity/好友/道具变更，也不写入聊天或记忆状态。
  async function dryRunConversationForTest(senderNum, senderName, content) {
    const requestPlan = await planUserRequest(senderNum, senderName, content, null);
    const result = {
      requestPlan,
      branch: requestPlan?.intent || "unknown",
      finalReply: "",
      raw: null,
      parsed: null,
      filtered: null,
      resolutions: [],
      activitySelection: null,
      activityDryRun: null,
      memoryResult: null,
    };
    if (requestPlan?.failed) {
      result.branch = "planner-failed";
      result.finalReply = await renderClarification(
        requestPlan.question || "我没确认好具体操作，能再说具体一点吗？",
      );
      return result;
    }
    if (requestPlan?.quotedReportOnly) {
      result.branch = "quoted-report";
      result.finalReply = "听到了，不过那只是转述，我不会把它当成操作指令。";
      return result;
    }
    if (requestPlan?.simpleRoleplay === "wink") {
      result.branch = "simple-roleplay";
      result.finalReply = "*朝你眨了眨眼*";
      return result;
    }
    if (requestPlan?.intent === "clarify") {
      result.finalReply = await renderClarification(
        requestPlan.question || "我还没确认好具体目标或操作，能再说清楚一点吗？",
      );
      return result;
    }
    if (requestPlan?.memorySearch) {
      result.branch = "memory";
      result.memoryResult = await answerMemoryQuestion(requestPlan, senderName, content);
      result.finalReply = result.memoryResult?.reply || "";
      return result;
    }
    if (requestPlan?.intent === "friendship") {
      const friendship = requestPlan.friendship || {};
      result.branch = "friendship";
      result.finalReply = friendship.explicit && Number(friendship.target) === Number(senderNum)
        ? "好呀，已经加上啦～"
        : "好友关系要由本人提出哦。";
      return result;
    }
    if (requestPlan?.intent === "activity") {
      const selection = await resolvePlannedActivity(requestPlan, senderName, content);
      result.activitySelection = selection;
      if (selection.ok) {
        result.activityDryRun = executeNativeActivity(selection, { dryRun: true });
        result.finalReply = result.activityDryRun?.ok ? "" : "这个动作现在做不了，我先不乱来。";
        return result;
      }
      if (shouldFallbackActivityToRoleplay(selection.reason)) {
        requestPlan.intent = "roleplay";
        requestPlan.stickerId = "";
        result.branch = "activity-roleplay-fallback";
      } else {
        result.finalReply = selection.reason === "target-not-in-room"
          ? "没找到这个人，做不了。"
          : "这个原生动作现在做不了。";
        return result;
      }
    }

    const recentForContext = state.recentMessages.slice(-CONFIG.maxContext);
    const contextMessages = trimContextByTokenBudget([
      ...recentForContext.map(message => ({
        role: message.isSelf ? "assistant" : "user",
        content: message.isSelf
          ? message.content
          : `${message.senderName}#${message.senderMemberNumber || "?"}: ${message.content}`,
      })),
      {
        role: "user",
        content: `【当前必须处理的最新消息】${senderName}#${senderNum}: ${content}\n只回复并执行这一条。历史消息只作上下文,不要补做旧请求。`,
      },
    ], CONFIG.maxContextTokens);
    const systemPrompt = buildMainReplySystemPrompt(requestPlan);
    let raw = await callLLM(systemPrompt, contextMessages, {
      thinking: true,
      temperature: 0,
      maxTokens: 2048,
      json: true,
    });
    let parsed = parseAssistantReply(raw || "", requestPlan.intent);
    let filtered = filterCommandsByPlan(requestPlan, parsed.commands);
    const initialIsQuestion = /[?？]\s*$/.test(parsed.cleaned || "");
    const planHasExactAssets = (requestPlan.operations || []).some(operation =>
      Array.isArray(operation.assets) && operation.assets.length > 0);
    if (requestPlan.intent === "action" && filtered.allowed.length === 0 &&
        (!initialIsQuestion || planHasExactAssets)) {
      const deterministic = buildDeterministicExactReplacementReply(requestPlan);
      if (deterministic) {
        raw = deterministic;
      } else {
        const correctionPrompt = `${systemPrompt}\n\n【本轮强制纠错】\n用户明确要求你执行操作，但你上一稿的 commands 没有任何可执行对象。必须根据当前名单和道具清单，在 commands 数组中输出正确的结构化操作对象，并在 speech 中简短回复。若 operations.assets 非空，则具体道具已经确定，必须直接使用其中的精确 Asset，禁止再次追问。只有计划本身没有精确目标、部位或道具时才能追问；绝不能只用 action 或 speech 声称已经完成。`;
        raw = await callLLM(correctionPrompt, contextMessages, {
          thinking: false,
          temperature: 0,
          maxTokens: 2048,
          json: true,
        }) || raw;
      }
      parsed = parseAssistantReply(raw || "", requestPlan.intent);
      filtered = filterCommandsByPlan(requestPlan, parsed.commands);
    }
    result.raw = raw;
    result.parsed = parsed;
    result.filtered = filtered;
    result.finalReply = normalizeAssistantIdentity(parsed.cleaned || "", content);
    if (requestPlan.intent === "action" && filtered.allowed.length === 0 &&
        !/[?？]\s*$/.test(result.finalReply)) {
      result.finalReply = "我没确认好具体操作,先不乱动。";
    }
    result.resolutions = filtered.allowed
      .filter(command => command.type === "itemadd")
      .map(command => {
        const char = actionTargetCharacter(command.memberNumber);
        const resolved = resolveItemAddTarget(char, command.item, command.part);
        return {
          command,
          resolved: resolved.ok
            ? {
                ok: true,
                group: resolved.group,
                asset: resolved.asset,
                partKind: resolved.partKind,
              }
            : resolved,
        };
      });
    return result;
  }

  async function handleReply(senderNum, senderName, content) {
    if (!isCurrent()) return;
    const debugId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.busy = true;
    window.__misakaGlobalBusy = true;
    state.lastReplyTime = Date.now();
    state.lastUserReplyTime[senderNum] = Date.now();
    pushDebugTrace({ id: debugId, stage: "start", senderNum, senderName, content });

    try {
      await new Promise(r => setTimeout(r, CONFIG.replyDelayMs));
      if (!isCurrent()) return;

      // 构建上下文(带时间戳 + 身份标识,帮 LLM 理解对话时间线和说话者)
      const recentForContext = state.recentMessages.slice(-CONFIG.maxContext);
      const latestIndex = recentForContext.length - 1;
      let contextMessages = recentForContext.map((m, idx) => {
        if (idx === latestIndex && !m.isSelf && m.senderMemberNumber === senderNum && m.content === content) return null;
        const t = new Date(m.time || Date.now());
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        if (m.isSelf) {
          // 御坂自己的消息不加时间戳和名字前缀,避免 LLM 模仿
          return { role: "assistant", content: m.content };
        }
        return {
          role: "user",
          content: `[${hh}:${mm}] ${m.senderName}#${m.senderMemberNumber || "?"}: ${m.content}`
        };
      }).filter(Boolean);
      contextMessages.push({
        role: "user",
        content: `【当前必须处理的最新消息】${senderName}#${senderNum}: ${content}\n只回复并执行这一条。历史消息只作上下文,不要补做旧请求。`
      });
      contextMessages = trimContextByTokenBudget(contextMessages, CONFIG.maxContextTokens);

      // 独立规划器先理解自然语言；主模型只在规划许可范围内生成具体指令。
      const pendingClarification = getPendingClarification(senderNum);
      const requestPlan = await planUserRequest(senderNum, senderName, content, pendingClarification);
      pushDebugTrace({ id: debugId, stage: "plan", requestPlan, pendingClarification: pendingClarification ? { context: pendingClarification.context, updatedAt: pendingClarification.updatedAt } : null });
      // 规划器自身失败时不要再让主模型自由发挥。否则安全层虽会拦截指令，
      // 自然语言回复仍可能谎称操作成功。
      if (requestPlan.failed) {
        const clarification = await renderClarification(requestPlan.question || "我没确认好具体操作，能再说具体一点吗？");
        pushDebugTrace({ id: debugId, stage: "guard:planner-failed", finalReply: clarification });
        sendReply(clarification);
        pushDebugTrace({ id: debugId, stage: "sent", finalReply: clarification });
        return;
      }
      if (requestPlan.quotedReportOnly) {
        const finalReply = "听到了，不过那只是转述，我不会把它当成操作指令。";
        pushDebugTrace({ id: debugId, stage: "guard:quoted-report", finalReply });
        sendReply(finalReply);
        pushDebugTrace({ id: debugId, stage: "sent", finalReply });
        return;
      }
      if (requestPlan.simpleRoleplay === "wink") {
        const finalReply = "*朝你眨了眨眼*";
        pushDebugTrace({ id: debugId, stage: "guard:simple-roleplay", finalReply });
        sendReply(finalReply);
        pushDebugTrace({ id: debugId, stage: "sent", finalReply });
        return;
      }
      // clarify 是规划器已经做出的安全决定，直接使用它的问题。继续调用主模型会让
      // 主模型无视计划、口头声称“收紧好了”，即使所有指令都被执行层拦住。
      if (requestPlan.intent === "clarify") {
        const clarification = await renderClarification(requestPlan.question || "我还没确认好具体目标或操作，能再说清楚一点吗？");
        rememberPendingClarification(senderNum, senderName, content, requestPlan,
          requestPlan.usedPendingClarification ? pendingClarification : null);
        pushDebugTrace({ id: debugId, stage: "guard:clarify", finalReply: clarification });
        sendReply(clarification);
        pushDebugTrace({ id: debugId, stage: "sent", finalReply: clarification });
        return;
      }
      // 同一发送者的下一条消息一旦被规划为可执行请求或新话题，本轮待澄清状态即结束。
      // 其他人的插话不会触碰这个按发送者分隔的状态。
      if (pendingClarification) {
        clearPendingClarification(senderNum);
        pushDebugTrace({ id: debugId, stage: "clarification:resolved", used: requestPlan.usedPendingClarification });
      }

      // 过去细节由规划器统一分流到单路 RAG。主回复模型不再决定是否搜索，
      // 也不再经历“自由草稿 → 二次查询 → 证据编辑器”的多轮链路。
      if (requestPlan.memorySearch) {
        const memoryResult = await answerMemoryQuestion(requestPlan, senderName, content);
        const finalReply = normalizeAssistantIdentity(memoryResult.reply, content);
        pushDebugTrace({ id: debugId, stage: "memory:answer", ...memoryResult });
        sendReply(finalReply);
        pushDebugTrace({ id: debugId, stage: "sent", finalReply });
        return;
      }

      if (requestPlan.intent === "friendship") {
        const friendship = requestPlan.friendship || {};
        let friendResult = { ok: false, reason: "friend-request-invalid" };
        if (friendship.explicit && Number(friendship.target) === Number(senderNum)) {
          friendResult = addNativeFriend(senderNum, {
            mode: "explicit-request",
            reason: `${senderName} 本人在当前消息中明确请求御坂添加好友`,
            evidence: [content],
          }, {
            // 这个开关只控制“自主判断并添加”；本人明确请求不应被误挡。
            ignoreFeatureSwitch: true,
            // 自主加好友的全局冷却与每日上限不应阻挡本人明确请求。
            ignoreRateLimit: true,
          });
        }
        pushDebugTrace({ id: debugId, stage: "friend:explicit-result", friendResult });
        let finalReply = "好友关系要由本人提出哦。";
        if (friendResult.ok) finalReply = "好呀，已经加上啦～";
        else if (friendResult.reason === "already-friend") finalReply = "我们已经是好友啦。";
        else if (friendResult.reason === "friend-rate-limit") finalReply = "今天先慢一点，过一阵再加吧。";
        else if (friendResult.reason === "automated-doll") finalReply = "娃娃账号不加入好友名单哦。";
        sendReply(finalReply);
        pushDebugTrace({ id: debugId, stage: "sent", finalReply });
        return;
      }

      // 房间内身体互动默认优先尝试 BC 原生 Activity。规划器只保留目标和
      // 自然语言意图，选择器只能从 BC 当下允许目录中选择；执行前还会重新
      // 枚举一次目录，避免姿势、距离、道具或权限变化后绕过原生校验。
      // 目录为空、没有语义吻合项，或候选在执行前已失效时，才降级成
      // *动作描写*；冷却、功能关闭和 API 故障不伪装成“已经做了”。
      if (requestPlan.intent === "activity") {
        const selection = await resolvePlannedActivity(requestPlan, senderName, content);
        pushDebugTrace({ id: debugId, stage: "activity:selection", selection });
        if (!selection.ok) {
          if (shouldFallbackActivityToRoleplay(selection.reason)) {
            requestPlan.intent = "roleplay";
            requestPlan.stickerId = "";
            pushDebugTrace({
              id: debugId,
              stage: "activity:fallback-roleplay",
              reason: selection.reason,
            });
          } else {
            const finalReply = selection.reason === "target-not-in-room"
              ? "没找到这个人，做不了。"
              : "这个原生动作现在做不了。";
            sendReply(finalReply);
            pushDebugTrace({ id: debugId, stage: "sent", finalReply });
            return;
          }
        } else {
          const activityResult = executeNativeActivity(selection);
          pushDebugTrace({ id: debugId, stage: "activity:result", activityResult });
          if (activityResult.ok) return;
          if (shouldFallbackActivityToRoleplay(activityResult.reason)) {
            requestPlan.intent = "roleplay";
            requestPlan.stickerId = "";
            pushDebugTrace({
              id: debugId,
              stage: "activity:fallback-roleplay",
              reason: activityResult.reason,
            });
          } else {
            let finalReply = "这个动作现在做不了，我先不乱来。";
            if (activityResult.reason === "activity-disabled") finalReply = "原生互动现在关着呢。";
            else if (activityResult.reason === "activity-cooldown") {
              finalReply = "慢一点啦，刚刚才互动过呢。";
            } else if (activityResult.reason === "target-not-in-room") {
              finalReply = "没找到这个人，做不了。";
            }
            sendReply(finalReply);
            pushDebugTrace({ id: debugId, stage: "sent", finalReply });
            return;
          }
        }
      }

      const needCatalog = requestPlan.intent === "action" && !!requestPlan.needsCatalog;
      let systemPrompt = buildMainReplySystemPrompt(requestPlan);
      console.log(`[MisakaChat] system prompt 构建完成(意图: ${requestPlan.intent}, 完整道具清单: ${needCatalog ? "是" : "否"})`);

      let reply = await callLLM(systemPrompt, contextMessages, { json: true });
      pushDebugTrace({ id: debugId, stage: "llm:first", reply });
      if (reply) {
        const firstPass = parseAssistantReply(reply, requestPlan.intent);
        pushDebugTrace({ id: debugId, stage: "parse:first", commands: firstPass.commands, cleaned: firstPass.cleaned });
        const bceCommands = firstPass.commands.filter(c => c.type === "bcequery");
        // 兜底:用户说"查一下XXX"但 LLM 没输出 BCEQUERY 时,自动提取查询目标
        const queryPattern = /(?:查(?:一查|一下|查)?|搜(?:一搜|一下)?|找(?:一找|一下)?)\s*([\u4e00-\u9fff\w]{2,20})/i;
        const queryMatch = content.match(queryPattern);
        if (bceCommands.length === 0 && queryMatch && queryMatch[1] && !/房间|名单|记录|道具|窝窝|颜色|几点|时间|状态/.test(queryMatch[1])) {
          const queryTarget = queryMatch[1].trim();
          console.log(`[MisakaChat] 自动触发 BCEQUERY 兜底: ${queryTarget}`);
          bceCommands.push({ type: "bcequery", target: queryTarget });
        }
        if (bceCommands.length > 0) {
          let extraContext = "";
          for (const cmd of bceCommands) {
            const results = await queryProfile(cmd.target);
            if (results) {
              extraContext += "\n\n【BCE档案查询结果:" + cmd.target + "】\n";
              extraContext += results.map(r => {
                let line = `${r.lastNick || r.name} (#${r.memberNumber}) - 上次在线/出现: ${r.seen}`;
                if (r.owner && r.owner !== "无") line += ` | 主人: ${r.owner}`;
                if (r.lovers && r.lovers !== "无") line += ` | 恋人: ${r.lovers}`;
                if (r.itemCount !== undefined) line += ` | ${r.itemCount}件束缚, ${r.lockCount}把锁`;
                if (r.description) line += `\n描述: ${r.description}${r.descNote||""}`;
                return line;
              }).join("\n");
              extraContext += "\n(直接用这些 BCE 档案信息回答;时间可作为 BCE 记录到的上次在线/出现时间。)";
            } else {
              extraContext += `\n\n【BCE档案查询结果:${cmd.target}】\n没有找到这个人的档案。\n`;
            }
          }
          reply = await callLLM(systemPrompt + extraContext, contextMessages, { json: true });
          pushDebugTrace({ id: debugId, stage: "llm:extra-context", reply });
        }
      }
      if (!reply) {
        console.warn("[MisakaChat] LLM 返回空,未回复");
        pushDebugTrace({ id: debugId, stage: "empty-reply" });
        return;
      }

      // 明确要求执行操作、但首轮没有任何可执行指令时，强制纠错一次。
      // 这比把自然语言“好了”当成功更安全，也覆盖绑第三人和修改第三人道具的场景。
      const initialParsed = parseAssistantReply(reply, requestPlan.intent);
      const initialExecutable = filterCommandsByPlan(requestPlan, initialParsed.commands).allowed;
      const initialCleaned = initialParsed.cleaned;
      const initialIsClarifyingQuestion = /[?？]\s*$/.test(initialCleaned || "");
      const planHasExactAssets = (requestPlan.operations || []).some(op =>
        Array.isArray(op.assets) && op.assets.length > 0);
      if (requestPlan.intent === "action" && initialExecutable.length === 0 &&
          (!initialIsClarifyingQuestion || planHasExactAssets)) {
        pushDebugTrace({ id: debugId, stage: "retry:no-action-command", reply });
        const deterministicReply = buildDeterministicExactReplacementReply(requestPlan);
        if (deterministicReply) {
          reply = deterministicReply;
          pushDebugTrace({ id: debugId, stage: "deterministic:exact-replacement", reply });
        } else {
          const correctionPrompt = `${systemPrompt}\n\n【本轮强制纠错】\n用户明确要求你执行操作，但你上一稿的 commands 没有任何可执行对象。必须根据当前名单和道具清单，在 commands 数组中输出正确的结构化操作对象，并在 speech 中简短回复。若 operations.assets 非空，则具体道具已经确定，必须直接使用其中的精确 Asset，禁止再次追问。只有计划本身没有精确目标、部位或道具时才能追问；绝不能只用 action 或 speech 声称已经完成。`;
          const retryReply = await callLLM(correctionPrompt, contextMessages, {
            thinking: false,
            json: true,
          });
          if (retryReply) {
            reply = retryReply;
            pushDebugTrace({ id: debugId, stage: "llm:action-retry", reply });
          }
        }
      } else if (requestPlan.intent === "action" && initialExecutable.length === 0 && initialIsClarifyingQuestion) {
        // 模型已经基于实时道具清单明确说明不可执行并追问时，这就是安全且有用的结果。
        // 不再用“必须输出指令”的纠错提示覆盖它，否则会诱导模型编造不存在的样式。
        pushDebugTrace({ id: debugId, stage: "retry:skipped-clarification", reply: initialCleaned });
      }

      // 解析操作指令
      const parsedReply = parseAssistantReply(reply, requestPlan.intent);
      const { commands, cleaned } = parsedReply;
      const planFiltered = filterCommandsByPlan(requestPlan, commands);
      const executableCommands = planFiltered.allowed;
      let finalReply = cleaned;
      let commandResult = null;  // 提前声明,避免 TDZ
      pushDebugTrace({
        id: debugId,
        stage: "parse:final",
        commands,
        executableCommands,
        rejectedCommands: [...(parsedReply.rejectedCommands || []), ...planFiltered.rejected],
        protocol: parsedReply.protocol,
        protocolError: parsedReply.protocolError,
        cleaned,
        finalReply,
      });

      // 二次纠错仍没有指令时，绝不能把“绑好了/调好了”之类口头成功发出去。
      // 若模型确实在追问则保留追问，否则明确告知本轮没有执行。
      if (requestPlan.intent === "action" && executableCommands.length === 0) {
        pushDebugTrace({ id: debugId, stage: "guard:action-without-command", rejectedReply: finalReply });
        const isClarifyingQuestion = /[?？]\s*$/.test(finalReply || "");
        if (!isClarifyingQuestion) finalReply = "我没确认好具体操作,先不乱动。";
      }

      // 执行操作
      if (planFiltered.rejected.length > 0) {
        console.warn("[MisakaChat] 已剔除计划外指令:", planFiltered.rejected);
        pushDebugTrace({ id: debugId, stage: "validate:filtered", rejected: planFiltered.rejected, kept: executableCommands });
      }
      if (executableCommands.length > 0) {
        if (!isCurrent()) return;
        // 在任何实际操作前冻结明确限制所关心的状态。后置条件验证命令是否真正
        // 生效；baseline 则验证 noMove/noAdd/preserveParts 等“不应变化”的部分。
        const actionBaseline = captureActionBaseline(requestPlan);
        const itemMutationTypes = new Set(["itemadd", "itemdel", "itemdelall", "itemset", "itemcolor", "snapshotRestore", "copyRestraint"]);
        const movementTypes = new Set(["move", "moveTo", "moveEdge"]);
        const itemMutationCount = executableCommands.filter(cmd => itemMutationTypes.has(cmd.type)).length;
        const movementTargets = [...new Set(executableCommands
          .filter(cmd => movementTypes.has(cmd.type))
          .map(commandPrimaryTarget)
          .filter(Number.isFinite))];
        const hasMovement = movementTargets.length > 0;
        // 任何多步道具操作都必须原子化。否则“先添加、后设样式”中后一步失败时，
        // 会留下半成品，却又只能对用户说本轮失败。单步操作无需额外快照。
        // 所有道具变更都先备份。这样不只是替换/多步操作，单步操作若确定性
        // 后置条件或语义映射验收失败，也能恢复到操作前状态。
        const transactionalItems = itemMutationCount > 0;
        const rollbackOnFailure = transactionalItems || hasMovement;
        const replacementBackups = new Map();
        if (transactionalItems) {
          for (const mn of new Set(executableCommands.map(commandPrimaryTarget).filter(Number.isFinite))) {
            const char = Number(mn) === Number(Player?.MemberNumber)
              ? Player
              : (ChatRoomCharacter || []).find(c => Number(c.MemberNumber) === Number(mn));
            if (char && typeof CharacterAppearanceStringify === "function") {
              replacementBackups.set(Number(mn), CharacterAppearanceStringify(char));
            }
          }
        }
        const transactionUpdates = transactionalItems ? new Map() : null;
        if (transactionUpdates) deferredCharacterUpdates = transactionUpdates;
        try {
          commandResult = await executeCommands(executableCommands);
          console.log("[MisakaChat] 操作执行:", executableCommands, commandResult);
          pushDebugTrace({ id: debugId, stage: "execute", executableCommands, commandResult });
          if (rollbackOnFailure && (commandResult.failures || []).length > 0) {
            commandResult.rollbackDetails = await rollbackActionState(actionBaseline, replacementBackups, movementTargets);
            commandResult.rolledBack = true;
            finalReply = "这次没弄成，我已经恢复原样了。";
            pushDebugTrace({ id: debugId, stage: "execute:rollback", reason: "action-failed", details: commandResult.rollbackDetails });
          }
          // 子指令成功后继续核对客观后置条件与明确限制；只有这些确定性检查
          // 失败才会回滚。LLM 语义复核只写入 debug，不再拥有驳回权。
          if ((commandResult.failures || []).length === 0) {
            const postExecutionAppearance = buildCurrentAppearanceFacts(requestPlan);
            commandResult.outcomeVerdict = await verifyActionOutcome(requestPlan, executableCommands, actionBaseline);
            pushDebugTrace({ id: debugId, stage: "verify:outcome", outcomeVerdict: commandResult.outcomeVerdict, finalAppearance: postExecutionAppearance });
            if (rollbackOnFailure && commandResult.outcomeVerdict.satisfied === false) {
              commandResult.rollbackDetails = await rollbackActionState(actionBaseline, replacementBackups, movementTargets);
              commandResult.rolledBack = true;
              commandResult.rollbackReason = "outcome-unsatisfied";
              finalReply = "这次没有完整弄好，我已经恢复原样了。";
              pushDebugTrace({ id: debugId, stage: "execute:rollback", reason: "outcome-unsatisfied", verifierReason: commandResult.outcomeVerdict.reason, rollbackDetails: commandResult.rollbackDetails, restoredAppearance: buildCurrentAppearanceFacts(requestPlan) });
            }
          }
        } finally {
          if (transactionUpdates) {
            deferredCharacterUpdates = null;
            // 事务期间的所有子步骤只产生这一轮最终状态同步。
            for (const char of transactionUpdates.values()) ChatRoomCharacterUpdate(char);
          }
        }
        // 操作失败时必须诚实反馈,不能保留"好了"这类与实际结果相反的自然回复
        const missing = (commandResult.failures || []).find(f =>
          f.reason === "missing-item" || f.reason === "missing-part-item"
        );
        const failed = (commandResult.failures || [])[0];
        if (missing?.cmd) {
          const who = displayNameByMemberNumber(missing.cmd.memberNumber);
          finalReply = `${who}身上没有${missing.cmd.item},没法改。`;
        } else if (failed) {
          const reason = failed.reason || "操作失败";
          if (reason === "move-blocked") finalReply = "前面被挡住了,只能挪到这里。";
          else if (reason === "没有找到快照") finalReply = "我没存过这个快照,绑不回去。";
          else if (/未锁道具/.test(reason)) finalReply = "没有可处理的未锁道具。";
          else if (reason === "locked-item" || /道具被锁/.test(reason)) finalReply = "这个道具锁着呢,我动不了。";
          else if (reason === "missing-character") finalReply = "没找到这个人,做不了。";
          else if (reason === "unknown-item") finalReply = "没找到这个道具,不能乱加。";
          else if (reason === "incompatible-part") finalReply = "这个道具不能戴在指定部位，我没有乱放到别处。";
          else if (reason === "final-item-missing" || reason === "final-item-still-present") finalReply = "子步骤虽然执行了，但最终状态不对，我没有把它算作完成。";
          else if (reason === "unknown-color") finalReply = "这个颜色我识别不了,给我个 #RRGGBB 吧。";
          else if (reason === "set-color-failed") finalReply = "颜色没改成,可能这个部件不能上色。";
          else if (/无法识别样式/.test(reason)) finalReply = "我没认出这种道具设置，本轮没有改动。";
          else if (/找不到部件/.test(reason)) finalReply = reason;
          else if (/找不到/.test(reason)) finalReply = "没找到目标,做不了。";
          // 未分类内部原因只进 debug trace，不得直接泄漏到正常聊天。
          else finalReply = "这次没操作成功，我先不乱动。";
        }
        // rollback 已在 debug trace 中记录；不要再用通用文案覆盖上面更具体的失败原因。
        if (commandResult.rolledBack && !finalReply) finalReply = "这次没弄成，我已经恢复原样了。";
        if ((commandResult.failures || []).length === 0) {
          const outcomeVerdict = commandResult.outcomeVerdict || { satisfied: null, reason: "verification-missing" };
          if (outcomeVerdict.satisfied === false) {
            if (!commandResult.rolledBack) {
              finalReply = "没完全弄好，我先停下了。";
            }
          } else if (outcomeVerdict.satisfied !== true) {
            finalReply = "我没确认好有没有弄成，先不乱说。";
          }
        }
      }

      // 如果只有指令没有文字回复,用默认回复
      if (!finalReply && executableCommands.length > 0) {
        const defaultReplies = ["好了~", "搞定了", "嗯,处理好了", "弄好了~", "已经调好了"];
        finalReply = defaultReplies[Math.floor(Math.random() * defaultReplies.length)];
      }
      if (!finalReply) return;
      if (!isCurrent()) return;

      finalReply = normalizeAssistantIdentity(finalReply, content);
      sendReply(finalReply);
      pushDebugTrace({ id: debugId, stage: "sent", finalReply });
      if (requestPlan.stickerId) {
        scheduleStickerAfterReply(finalReply, requestPlan.stickerId, debugId);
      }
      if (CONFIG.autoFriendEnabled && ["chat", "roleplay"].includes(requestPlan.intent)) {
        maybeAutoFriend(senderNum, senderName, content).then(result => {
          pushDebugTrace({ id: debugId, stage: "friend:auto-result", result });
        }).catch(error => {
          pushDebugTrace({ id: debugId, stage: "friend:auto-error", reason: error.message });
        });
      }

    } catch (e) {
      if (isCurrent()) {
        console.error("[MisakaChat] 回复失败:", e.message);
        pushDebugTrace({ id: debugId, stage: "error", error: e.message });
      }
    } finally {
      state.busy = false;
      if (isCurrent()) {
        window.__misakaGlobalBusy = false;
        window.__misakaReplyInProgress = false;
      }
    }
  }

  // === [Commands] /misaka 命令系统 ===
  function handleCommand(msg) {
    if (!msg || !msg.startsWith("/misaka")) return false;
    const cmd = msg.slice("/misaka".length).trim();
    const parts = cmd.split(/\s+/);
    const sub = parts[0];
    if (sub === "on") { CONFIG.enabled = true; sendLocal("✅ 已开启：自动回复"); }
    else if (sub === "off") { CONFIG.enabled = false; sendLocal("⏹ 已关闭：自动回复"); }
    else if (sub === "key" && parts[1]) { localStorage.setItem(storageKey("apikey"), parts[1]); sendLocal("✅ 已保存：API key"); }
    else if (sub === "embedkey" && parts[1]) { localStorage.setItem("misaka_openai_key", parts[1]); sendLocal("✅ 已保存：OpenAI embedding key"); }
    else if (sub === "model" && parts[1]) { localStorage.setItem(storageKey("model"), parts[1]); CONFIG.model = parts[1]; sendLocal("✅ 已切换：模型 | 当前模型：" + parts[1]); }
    else if (sub === "activity" && ["on", "off"].includes(parts[1])) {
      CONFIG.activityEnabled = parts[1] === "on";
      localStorage.setItem(storageKey("activity_enabled"), String(CONFIG.activityEnabled));
      sendLocal(`${CONFIG.activityEnabled ? "✅ 已开启" : "⏹ 已关闭"}：原生互动`);
    }
    else if (sub === "sticker" && ["on", "off"].includes(parts[1])) {
      const wantsEnabled = parts[1] === "on";
      CONFIG.stickerEnabled = wantsEnabled && getStickerCatalog().length > 0;
      localStorage.setItem(storageKey("sticker_enabled"), String(CONFIG.stickerEnabled));
      if (wantsEnabled && !CONFIG.stickerEnabled) {
        sendLocal("⚠️ 无法开启表情包：尚未配置正式目录");
      } else {
        sendLocal(`${CONFIG.stickerEnabled ? "✅ 已开启" : "⏹ 已关闭"}：表情包`);
      }
    }
    else if (sub === "friend" && ["on", "off"].includes(parts[1])) {
      CONFIG.autoFriendEnabled = parts[1] === "on";
      localStorage.setItem(storageKey("auto_friend_enabled"), String(CONFIG.autoFriendEnabled));
      sendLocal(`${CONFIG.autoFriendEnabled ? "✅ 已开启" : "⏹ 已关闭"}：自动加好友`);
    }
    else if (sub === "status") {
      const key = getApiKeyStatus();
      const embed = getEmbeddingProviderStatus();
      sendLocal(`状态：${CONFIG.enabled?"开启":"关闭"} | 原生互动：${CONFIG.activityEnabled?"开启":"关闭"} | 表情包：${CONFIG.stickerEnabled?"开启":"关闭"} | 自动加好友：${CONFIG.autoFriendEnabled?"开启":"关闭"} | 模型：${CONFIG.model} | 语义记忆：${state.semanticMemories.length} | 提炼记忆：${state.refinedMemories.length} | 人物：${Object.keys(loadMemory().profiles||{}).length}`);
    } else if (sub === "forget") {
      localStorage.setItem(storageKey("memory"), "{}");
      state.semanticMemories = [];
      state.refinedMemories = [];
      IDB.clearAll();
      sendLocal("✅ 已清空：全部记忆");
    }
    else if (sub === "export") {
      IDB.exportAll().then(data => {
        window.__misakaExportData = JSON.stringify(data);
        console.log("[MisakaChat] 导出数据已存入 window.__misakaExportData");
        sendLocal(`✅ 已导出记忆 | 语义记忆：${data.semantic.length} | 提炼记忆：${data.refined.length} | 位置：window.__misakaExportData`);
      });
    }
    else if (sub === "import") {
      const blob = window.__misakaExportData;
      if (!blob) { sendLocal("⚠️ 未找到可导入的数据；请先执行 /misaka export"); }
      else {
        try {
          const data = JSON.parse(blob);
          IDB.importAll(data).then(() => {
            state.semanticMemories = data.semantic || [];
            state.refinedMemories = data.refined || [];
            sendLocal(`✅ 已导入记忆 | 语义记忆：${data.semantic?.length || 0} | 提炼记忆：${data.refined?.length || 0}`);
          });
        } catch(e) { sendLocal("❌ 导入记忆失败：" + e.message); }
      }
    }
    else if (sub === "memory") {
      const mem = loadMemory();
      const profiles = Object.entries(mem.profiles || {});
      if (profiles.length === 0) sendLocal("人物记忆：空");
      else profiles.forEach(([mn, info]) => sendLocal(`人物：${info.name} | 编号：#${mn} | 互动：${info.chatCount||0}次 | 最近聊天：${info.lastChat||"未知"}`));
    } else if (sub === "trace") {
      try {
        const records = JSON.parse(localStorage.getItem(storageKey("capability_trace")) || "[]");
        window.__misakaCapabilityTraceExport = JSON.stringify(Array.isArray(records) ? records : [], null, 2);
        sendLocal(`✅ 已导出能力记录 | 数量：${Array.isArray(records) ? records.length : 0} | 位置：window.__misakaCapabilityTraceExport`);
      } catch (e) {
        sendLocal("❌ 导出能力记录失败");
      }
    } else if (sub === "persona" && parts[1]) {
      localStorage.setItem(storageKey("persona_extra"), parts.slice(1).join(" "));
      sendLocal("✅ 已更新：人设附加备注");
    } else {
      sendLocal("用法：/misaka on|off|activity on|off|sticker on|off|friend on|off|key <key>|embedkey <openai-key>|model <name>|status|trace|forget|memory|persona <text>|export|import");
    }
    return true;
  }

  function sendLocal(msg) {
    try {
      if (typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom") {
        ChatRoomMessage({ Content: `<font color="#00CCFF">[MisakaChat] ${msg}</font>`, Type: "LocalMessage", Sender: Player.MemberNumber });
      }
    } catch (e) {}
  }

  // === [Init] 初始化 ===
  function init() {
    if (!isCurrent() || TEST_MODE) return;
    if (typeof Player === "undefined" || !Player) { trackedTimeout(init, 1000); return; }
    if (Player.MemberNumber !== 194331) { console.log("[MisakaChat] 非御坂账号,跳过"); return; }
    const savedModel = localStorage.getItem(storageKey("model")) || "";
    if (savedModel) CONFIG.model = savedModel;
    const savedActivityEnabled = localStorage.getItem(storageKey("activity_enabled"));
    if (savedActivityEnabled !== null) CONFIG.activityEnabled = savedActivityEnabled === "true";
    const savedStickerEnabled = localStorage.getItem(storageKey("sticker_enabled"));
    if (savedStickerEnabled !== null) CONFIG.stickerEnabled = savedStickerEnabled === "true";
    if (getStickerCatalog().length === 0) CONFIG.stickerEnabled = false;
    const savedAutoFriendEnabled = localStorage.getItem(storageKey("auto_friend_enabled"));
    if (savedAutoFriendEnabled !== null) CONFIG.autoFriendEnabled = savedAutoFriendEnabled === "true";
    const savedFriendRate = loadFriendRateState();
    state.lastAutoFriendTime = savedFriendRate.lastTime;
    state.autoFriendDaily = savedFriendRate.daily;

    const existingMods = bcModSdk.getModsInfo();
    const existingMod = existingMods.find(m => m.name === "MisakaChat");
    let mod;
    if (existingMod) { console.log("[MisakaChat] mod 已注册"); mod = { hookFunction: () => {} }; }
    else {
      mod = bcModSdk.registerMod({ name: "MisakaChat", fullName: "Misaka Auto Chat v3", version: SCRIPT_VERSION, repository: "https://github.com/Igallta/bc-gimp-sorter" });
    }

   window.__misakaOnMessage = onChatRoomMessage;

   // 方案 1: hook ServerSocket.onevent - 在 socket 事件层拦截,最可靠
   if (isCurrent() && typeof ServerSocket !== "undefined" && ServerSocket.onevent) {
     if (!window.__misakaSocketHooked) {
       const origOnevent = ServerSocket.onevent;
       ServerSocket.onevent = function(packet) {
         try {
           const d = packet?.data;
           if (Array.isArray(d) && d[0] === "ChatRoomMessage" && d[1] && window.__misakaOnMessage) {
             window.__misakaOnMessage(d[1]);
           }
         } catch(e) { console.error("[MisakaChat] socket hook error:", e.message); }
         return origOnevent.apply(this, arguments);
       };
       window.__misakaSocketHooked = true;
       console.log("[MisakaChat] ServerSocket.onevent hook 已设置");
     }
   }

   // 方案 2 (fallback): window.ChatRoomMessage wrapper
   if (isCurrent()) {
     const orig = window.__misakaOrigChatRoomMessage || window.ChatRoomMessage;
     window.__misakaOrigChatRoomMessage = orig;
     window.ChatRoomMessage = function(data) {
       try { if (data?.Content && window.__misakaOnMessage) window.__misakaOnMessage(data); }
       catch(e) { console.error("[MisakaChat] wrapper error:", e.message); }
       return orig.apply(this, arguments);
     };
     console.log("[MisakaChat] ChatRoomMessage wrapper 已设置/刷新 v2.0");
   }

    mod.hookFunction("ChatRoomSendChat", 10, (args, next) => {
      // ChatRoomSendChat 通常没有消息参数，BC 会直接从 InputChat 读取文本。
      // 旧逻辑只看 args[0]，导致 /misaka 被放行给 BC 原生命令系统并报“没有该命令”。
      let msg = typeof args?.[0] === "string" ? args[0] : "";
      if (!msg) {
        try { msg = ElementValue("InputChat") || ""; } catch(e) {}
      }
      msg = String(msg || "").trim();
      if (msg.startsWith("/misaka") && handleCommand(msg)) {
        try { ElementValue("InputChat", ""); } catch(e) {}
        return;
      }
      return next(args);
    });

    console.log(`[MisakaChat] ✅ 已初始化 ${SCRIPT_VERSION}`);
    startIdleTimer();
  }


  if (!TEST_MODE) {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      trackedTimeout(init, 2000);
    } else {
      const onLoad = () => trackedTimeout(init, 2000);
      window.addEventListener("load", onLoad, { once: true });
      onDispose(() => window.removeEventListener("load", onLoad));
    }
  }
})();
