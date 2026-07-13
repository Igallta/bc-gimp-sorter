// MisakaChat v2.9.6 - BC 御坂自动回复系统
// 模块分区:
//   [Config]      L15-55   配置 + 状态
//   [Memory]      L56-440  IndexedDB / Embedding / 语义记忆 / Refine
//   [Idle]        L441-527 闲聊 / Heartbeat
//   [API]         L528-633 callLLM / 速率限制 / Token 预算
//   [Persona]     L634-664 人设 + 房间名单缓存
//   [Actions]     L665-1459 指令解析 / 道具操作 / 移动 / ToolPolicy
//   [Chat]        L1460-1830 消息处理 / 噪音过滤 / handleReply / sanitize
//   [BCE]         L1582-1641 BCE 查询
//   [Commands]    L1831-1892 /misaka 命令系统
//   [Init]        L1893-end 初始化 / hook 安装

(function() {
  "use strict";

  const SCRIPT_VERSION = "2.9.6";
  const RELEASE_CHANNEL = "stable";
  window.__misakaScriptVersion = SCRIPT_VERSION;

  if (window.__misakaInstance) console.log("[MisakaChat] 杀掉旧实例 #" + window.__misakaInstance);
  window.__misakaInstance = Date.now();
  const myInstance = window.__misakaInstance;
  function isCurrent() { return window.__misakaInstance === myInstance; }

  const CONFIG = {
    enabled: true,
    apiBase: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    fallbackModel: "deepseek-v4-flash",
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
    maxProfileEntries: 20,
    moveCooldownMs: 500,  // 移动操作冷却
    idleTimeoutMs: 600000,  // 10 分钟无人说话触发 idle
    idleCheckMs: 60000,  // 每分钟检查一次 idle
    embeddingProviders: [
      {
        name: "OpenRouter Qwen",
        base: "https://openrouter.ai/api/v1/embeddings",
        model: "qwen/qwen3-embedding-8b",
        keyNames: ["misaka_openrouter_key", "misaka_apikey"],
        dimensions: null,
      },
      {
        name: "OpenAI legacy",
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
  };

  let state = {
    recentMessages: [],
    lastReplyTime: 0,
    lastUserReplyTime: {},
    messageCount: 0,
    busy: false,
    lastMoveTime: 0,  // 移动操作冷却
    lastNonSelfMsgTime: 0,  // 上次非自己消息时间(idle 检测用)
    roomLog: [],          // 进出记录
    snapshots: {},        // 束缚快照 { memberNumber: { items, time } }
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
  function pushDebugTrace(entry) {
    try {
      const trace = window.__misakaDebugTrace;
      trace.push({
        time: new Date().toISOString(),
        ...entry
      });
      while (trace.length > 30) trace.shift();
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
  state.semanticMemories = [];
  state.refinedMemories = [];
  state.idbReady = false;

  IDB.getSemantic().then(entries => {
    if (Array.isArray(entries)) {
      // 按 time 排序(IndexedDB autoIncrement id 基本保序,但显式排序更稳)
      entries.sort((a, b) => (a.time || 0) - (b.time || 0));
      state.semanticMemories = entries;
    }
    state.idbReady = true;
    console.log(`[MisakaChat] IDB 加载完成: ${state.semanticMemories.length} 条语义记忆`);
  }).catch(e => {
    state.idbReady = true;
    console.warn("[MisakaChat] IDB 加载语义记忆失败,从空开始:", e.message);
  });

  IDB.getRefined().then(entries => {
    if (Array.isArray(entries)) {
      entries.sort((a, b) => (a.time || 0) - (b.time || 0));
      state.refinedMemories = entries;
    }
    console.log(`[MisakaChat] IDB 加载完成: ${state.refinedMemories.length} 条提炼记忆`);
  }).catch(e => {
    console.warn("[MisakaChat] IDB 加载提炼记忆失败:", e.message);
  });




  function storageKey(prefix) { return "misaka_" + prefix; }

  function loadMemory() {
    try { return JSON.parse(localStorage.getItem(storageKey("memory")) || "{}"); }
    catch (e) { return { profiles: {} }; }
  }

  function saveMemory(mem) {
    try { localStorage.setItem(storageKey("memory"), JSON.stringify(mem)); }
    catch (e) { console.error("[MisakaChat] 保存记忆失败:", e.message); }
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
      keys.sort((a, b) => new Date(mem.profiles[a].lastChat || 0) - new Date(mem.profiles[b].lastChat || 0));
      delete mem.profiles[keys[0]];
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
  // 优先走 OpenRouter Qwen embedding；保留旧 OpenAI key 作为显式 fallback。
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

  async function searchLongTermMemories(query, topK = CONFIG.topKMemories) {
    const qEmb = await getEmbedding(query);
    if (!qEmb) return [];
    const now = Date.now();
    const results = [];

    // 只搜语义记忆(refined_mem 已在 system prompt 全量注入)
    const sources = [
      { list: state.semanticMemories, source: "semantic" },
    ];
    for (const { list, source } of sources) {
      if (!Array.isArray(list)) continue;
      for (const m of list) {
        const text = typeof m === "string" ? m : m?.text;
        const emb = typeof m === "string" ? null : m?.embedding;
        if (!text) continue;
        if (emb) {
          const decayed = cosineSim(qEmb, emb) * Math.max(0.3, 1 - ((now - (m.time || 0)) / 86400000) / 90);
          if (decayed > 0.3) results.push({ text, score: decayed, source });
        } else {
          // 关键词 fallback(无 embedding 的旧条目)
          const q = query.toLowerCase(), lower = text.toLowerCase();
          const terms = q.split(/[\s,,、。.!!??;;::]+/).filter(t => t.length >= 2);
          let kw = lower.includes(q) ? 3 : 0;
          for (const t of terms) if (lower.includes(t)) kw++;
          if (kw > 0) results.push({ text, score: kw, source: source + "-keyword" });
        }
      }
    }

    // 去重 + 排序 + 截断
    const seen = new Set();
    return results
      .filter(r => r.text && !seen.has(r.text) && seen.add(r.text))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async function buildMemorySearchContext(memCommands) {
    const queries = [...new Set((memCommands || []).map(c => c.query).filter(Boolean))].slice(0, 3);
    if (queries.length === 0) return "";
    const blocks = [];
    for (const query of queries) {
      const found = await searchLongTermMemories(query, CONFIG.topKMemories);
      if (found.length > 0) {
        blocks.push(`查询「${query}」:\n` + found.map(m => {
          const t = m.time ? new Date(m.time).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}) : "";
          return `- [${t}] ${m.text}`;
        }).join("\n"));
      } else {
        blocks.push(`查询「${query}」: 没有找到明确记忆`);
      }
    }
    return "\n\n【长期记忆搜索结果】\n" + blocks.join("\n");
  }





  // === [Memory] Long-term Memory Refinement ===
  // 每 memoryRefineInterval 条消息,用 LLM 从 profiles + semanticMemories 提炼长期记忆
  async function maybeRefineMemory() {
    if (state.messageCount % CONFIG.memoryRefineInterval !== 0) return;
    if (state.messageCount === 0) return;
    try {
      const mem = loadMemory();
      const profiles = Object.entries(mem.profiles || {}).map(([mn, info]) =>
        `#${mn} ${info.name}: ${info.notes || ""} (${info.chatCount || 0}次互动)`).join("\n");
      const recentSemantic = (state.semanticMemories || []).slice(-20).map(m => m.text).join("\n");

      const existingRefined = (state.refinedMemories || []).map(m => m.text).join("\n");

      const prompt = `从以下 BC 聊天记录中,提炼出【新的】长期有价值信息(人际关系变化、明确偏好、重要事件、约束关系),不超过100字,用中文。

已有的概括记忆(不要重复这些内容,只提炼增量):
${existingRefined || "(空)"}

重要限制:
- 不要重复已有记忆里已经说过的信息。如果这批聊天记录里没有新信息,直接回复"无"。
- 不要把"让御坂改成某种颜色/操作某个颜色"当成用户偏好。
- 只有用户明确说"我喜欢/我最喜欢/我偏好/我讨厌"时,才能提炼为偏好。
- 御坂自我描述的外貌不一定准确,不要把御坂的自我介绍当作外貌事实。
- 不要推断原因和细节,只提炼明确说出的内容。
- 区分说话者:用户说的提炼为事实,御坂说的只提炼御坂自身偏好。

人物档案:
${profiles}

记忆片段:
${recentSemantic}`;
      const refined = await callLLM("你是记忆提炼助手。只提炼有明确证据的长期信息,禁止把操作请求推断成偏好。", [{role:"user", content: prompt}], {
        model: CONFIG.fallbackModel,
        fallbackModel: CONFIG.fallbackModel,
      });
      if (refined && refined.trim() && !/^(无|没有|none|n\/a)\s*$/i.test(refined.trim())) {
        const ts = Date.now();
        const time = new Date(ts).toLocaleDateString("zh-CN", {month:"2-digit",day:"2-digit"});
        const refinedText = `[${time}] ${refined.slice(0, 100)}`;
        // 提炼去重:和已有提炼做相似度检查
        const refDup = await searchMemories(refinedText, 1);
        if (refDup.length > 0 && refDup[0].score > 0.85) {
          console.log("[MisakaChat] 提炼记忆去重跳过:", refined.slice(0, 40));
          return;
        }
        // 给 refined memory 算 embedding,让语义搜索能命中
        let refinedEmb = null;
        try { refinedEmb = await getEmbedding(refinedText); } catch(e) {}
        const entry = { text: refinedText, embedding: refinedEmb, time: ts };
        state.refinedMemories.push(entry);
        if (state.refinedMemories.length > CONFIG.maxRefinedMemories) {
          state.refinedMemories.shift();
        }
        // refined 最多 20 条,先 clear 再全量写,避免 autoIncrement 重复堆积
        IDB.clearRefined().then(() => Promise.all(state.refinedMemories.map(m => IDB.putRefinedOne(m))));
        console.log("[MisakaChat] 长期记忆提炼完成:", refined.slice(0, 50));
      }
    } catch(e) {
      console.warn("[MisakaChat] 记忆提炼失败:", e.message);
    }
  }

  // === [Idle] Idle / Heartbeat ===
  let idleTimer = null;

  async function generateIdleLine() {
    try {
      // idle 去重:记录最近发过的 idle 内容
      if (!state.recentIdleLines) state.recentIdleLines = [];
      const recentIdle = state.recentIdleLines.slice(-3);
      // idle 不需要道具清单,用精简 prompt
      const systemPrompt = getSystemPrompt(false) +
        "\n\n【当前任务】房间安静了。自然地说一句闲聊或做一个小动作。只输出最终回复本身,不要分析、不要描述你在做什么、不要输出思考过程。直接给出那句话。";
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
      const userPrompt = `最近消息:\n${recent || "暂无消息"}${idleGuard}${idleHint}\n\n直接输出一句自然的闲聊(不超过40字),不要分析,不要解释。`;
      const reply = await callLLM(systemPrompt, [{ role: "user", content: userPrompt }], {
        model: CONFIG.fallbackModel,
        fallbackModel: CONFIG.fallbackModel,
        maxTokens: 80,
      });
      const cleaned = sanitizeReply(reply || "");
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
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(async () => {
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
            ElementValue("InputChat", line);
            ChatRoomSendChat();
            state.recentMessages.push({ senderName: "御搬", content: line, isSelf: true, time: Date.now() });
            if (state.recentMessages.length > 50) state.recentMessages.shift();
          }
        } catch(e) { console.warn("[MisakaChat] idle 发送失败:", e.message); }
        finally {
          state.busy = false;
          window.__misakaGlobalBusy = false;
          window.__misakaReplyInProgress = false;
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
  // === [API] LLM 速率限制 ===
  const rateLimiter = {
    window: 60000, maxCalls: 30, calls: [], // 御坂有 3s 全局冷却 + 5s 单用户冷却,30 次/分钟足够
    canCall() { const now = Date.now(); this.calls = this.calls.filter(t => now - t < this.window); return this.calls.length < this.maxCalls; },
    record() { this.calls.push(Date.now()); }
  };

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
    // 速率限制检查
    if (!rateLimiter.canCall()) {
      console.warn("[MisakaChat] LLM 速率限制: 1分钟内超过 " + rateLimiter.maxCalls + " 次调用");
      return null;
    }
    const apiKey = getApiKeyStatus().value;
    if (!apiKey) { console.warn("[MisakaChat] 未设置 API key"); return null; }
    rateLimiter.record();
    const messages = [{ role: "system", content: systemPrompt }, ...contextMessages];
    const primaryModel = options.model || CONFIG.model;
    const fallbackModel = options.fallbackModel || CONFIG.fallbackModel;
    const maxTokens = options.maxTokens || CONFIG.maxTokens;

    const useThinking = options.thinking !== false;
    return new Promise((resolve) => {
      const doRequest = (url, model, isFallback) => {
        // thinking 模式:思考进 reasoning_content,回复进 content
        const bodyObj = { model, messages, max_tokens: maxTokens };
        // DeepSeek 默认会启用 thinking。仅仅省略 thinking 参数并不等于关闭；
        // 小 token 预算的规划器会把额度全部耗在 reasoning_content，最终 content=null。
        bodyObj.thinking = { type: useThinking ? "enabled" : "disabled" };
        const reqBody = JSON.stringify(bodyObj);
        const useGM = typeof window.__GM_xmlhttpRequest !== "undefined";

        if (useGM) {
          window.__GM_xmlhttpRequest({
            method: "POST", url, headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + apiKey
            }, data: reqBody, timeout: CONFIG.apiKeyTimeout,
            onload: (resp) => {
              try {
                const data = JSON.parse(resp.responseText);
                if (data.choices?.length > 0) { const r = extractReply(data.choices[0].message); if (r) resolve(r); else if (!isFallback) doRequest(url, fallbackModel, true); else resolve(null); }
                else resolve(null);
              } catch (e) {
                if (!isFallback) doRequest(url, fallbackModel, true);
                else resolve(null);
              }
            },
            onerror: () => { if (!isFallback) doRequest(url, fallbackModel, true); else resolve(null); },
            ontimeout: () => { if (!isFallback) doRequest(url, fallbackModel, true); else resolve(null); }
          });
        } else {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", url, true);
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.setRequestHeader("Authorization", "Bearer " + apiKey);
          xhr.timeout = CONFIG.apiKeyTimeout;
          xhr.onload = () => {
            try {
              const data = JSON.parse(xhr.responseText);
              if (data.choices?.length > 0) { const r = extractReply(data.choices[0].message); if (r) resolve(r); else if (!isFallback) doRequest(url, fallbackModel, true); else resolve(null); }
              else resolve(null);
            } catch (e) {
              if (!isFallback) doRequest(url, fallbackModel, true);
              else resolve(null);
            }
          };
          xhr.onerror = () => { if (!isFallback) doRequest(url, fallbackModel, true); else resolve(null); };
          xhr.ontimeout = () => { if (!isFallback) doRequest(url, fallbackModel, true); else resolve(null); };
          xhr.send(reqBody);
        }
      };
      doRequest(CONFIG.apiBase, primaryModel, false);
    });
  }

  // === [Persona] 人设 + 房间名单缓存 ===
  let _rosterCache = { snapshot: "", roster: "", time: 0 };
  let _itemCatalogCache = { text: "", time: 0 };

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

  // 自然语言操作规划由独立 LLM 调用完成。执行层不再用关键词/正则猜测用户意图。
  async function planUserRequest(senderNum, senderName, content) {
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
    const plannerPrompt = `你是 BC 操作请求规划器。只输出一行严格 JSON，不要 markdown，不要回复用户。
根据最新消息判断是 chat、action 还是 clarify。自然语言含糊但有常见合理解释时仍选 action；只有目标或操作无法安全确定时选 clarify。
actionTypes 只能从 itemadd,itemdel,itemdelall,itemset,itemcolor,move,moveTo,moveEdge,snapshotSave,snapshotRestore,copyRestraint,emote 中选择。
把语义相容的类型都列出，例如“绑成某种绑法”通常允许 itemadd 和 itemset；“换个更严格的绑法”也可允许先移除再添加。
targets 必须使用房间名单中的编号。“我/给我/把我”指说话者#${senderNum}；“你/御坂/你自己”指御坂#${Player?.MemberNumber || "?"}。
parts 只在用户明确限定单一身体部位时填写标准值 Arms/Hands/Legs/Feet/Mouth/Head/Neck/Torso/Pelvis/Breast/Eyes/Ears/Vulva，否则空数组。中文“绑手/把手绑住/手上的麻绳/手铐”在 BC 中通常属于整条手臂束缚，规划为 Arms；只有明确说手掌、手指或指定 ItemHands 道具时才规划为 Hands。LeatherDeluxeCuffs 固定属于 Arms。
needsCatalog 表示是否涉及道具、穿着、束缚、属性或颜色；移动/表情/闲聊为 false。
goal 用一句短话保留用户真正想达到的最终状态（例如“驷马缚”“更严格但不叠加”），不要只写“操作道具”。
constraints 只记录用户明确表达的限制：noMove=禁止移动，noAdd=禁止新增，replaceExisting=替换而非叠加，noStack=不要叠加；preserveParts 是明确要求不要碰的部位。
格式:{"intent":"action|chat|clarify","needsCatalog":true,"goal":"最终目标","constraints":{"noMove":false,"noAdd":false,"replaceExisting":false,"noStack":false,"preserveParts":[]},"operations":[{"types":["itemadd"],"targets":[123],"parts":[]}],"question":""}
房间名单:${roster}
说话者当前实时道具:${senderItems}
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
      if (!["action", "chat", "clarify"].includes(plan.intent)) throw new Error("invalid intent");
      const validTypes = new Set(["itemadd","itemdel","itemdelall","itemset","itemcolor","move","moveTo","moveEdge","snapshotSave","snapshotRestore","copyRestraint","emote"]);
      const validParts = new Set(["Arms","Hands","Legs","Feet","Mouth","Head","Neck","Torso","Pelvis","Breast","Eyes","Ears","Vulva"]);
      const roomNumbers = new Set((ChatRoomCharacter || []).map(c => Number(c.MemberNumber)));
      if (Player?.MemberNumber) roomNumbers.add(Number(Player.MemberNumber));
      plan.operations = (Array.isArray(plan.operations) ? plan.operations : []).map(op => ({
        types: (Array.isArray(op?.types) ? op.types : []).filter(t => validTypes.has(t)),
        targets: (Array.isArray(op?.targets) ? op.targets : []).map(Number).filter(n => roomNumbers.has(n)),
        parts: (Array.isArray(op?.parts) ? op.parts : []).filter(p => validParts.has(p)),
      })).filter(op => op.types.length > 0 && op.targets.length > 0);
      plan.goal = typeof plan.goal === "string" ? plan.goal.trim().slice(0, 200) : "";
      const rawConstraints = (plan.constraints && typeof plan.constraints === "object") ? plan.constraints : {};
      plan.constraints = {
        noMove: rawConstraints.noMove === true,
        noAdd: rawConstraints.noAdd === true,
        replaceExisting: rawConstraints.replaceExisting === true,
        noStack: rawConstraints.noStack === true,
        preserveParts: (Array.isArray(rawConstraints.preserveParts) ? rawConstraints.preserveParts : []).filter(p => validParts.has(p)),
      };
      // 基于规划器已经给出的结构化道具意图补全“添加后调样式”的客观操作族，
      // 不再回头用原始中文关键词猜语义。命名绑法往往同时需要 ITEMADD + ITEMSET。
      for (const op of plan.operations) {
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
      return plan;
    } catch (e) {
      console.warn("[MisakaChat] 请求规划失败:", e.message, result);
      return { intent: "clarify", needsCatalog: false, operations: [], question: "我没听明白要做什么，能再说具体一点吗？", failed: true };
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

  function commandMatchesPlannedOperation(cmd, operation) {
    if (!cmd || !operation) return false;
    const types = Array.isArray(operation.types) ? operation.types : [];
    if (!types.includes(cmd.type)) return false;
    const targets = (Array.isArray(operation.targets) ? operation.targets : []).map(Number);
    const target = commandPrimaryTarget(cmd);
    if (targets.length > 0 && target !== null && !targets.includes(target)) return false;
    const parts = Array.isArray(operation.parts) ? operation.parts : [];
    if (parts.length > 0 && ["itemadd", "itemdel", "itemset"].includes(cmd.type)) {
      if (!cmd.part || !parts.includes(cmd.part)) return false;
    }
    return true;
  }

  // 逐条保留计划内指令，夹带动作单独剔除，不再因一条错误指令拒绝整组操作。
  function filterCommandsByPlan(plan, commands) {
    const executable = commands.filter(c => !["memsearch", "bcequery"].includes(c.type));
    if (!plan || plan.intent !== "action") {
      return { allowed: [], rejected: executable.map(cmd => ({ cmd, reason: "not-an-action-plan" })) };
    }
    const operations = Array.isArray(plan.operations) ? plan.operations : [];
    const constraints = plan.constraints || {};
    const allowed = [], rejected = [];
    for (const cmd of executable) {
      let reason = "";
      if (!operations.some(op => commandMatchesPlannedOperation(cmd, op))) reason = "outside-plan";
      else if (constraints.noMove && ["move", "moveTo", "moveEdge"].includes(cmd.type)) reason = "movement-forbidden";
      else if (constraints.noAdd && cmd.type === "itemadd") reason = "adding-forbidden";
      else if ((constraints.preserveParts || []).includes(cmd.part)) reason = "part-must-be-preserved";
      if (reason) rejected.push({ cmd, reason });
      else allowed.push(cmd);
    }
    // “替换/不要叠加”必须先移除再添加。只接受原序列中有同目标、同部位的前置删除。
    if (constraints.replaceExisting || constraints.noStack) {
      for (let i = allowed.length - 1; i >= 0; i--) {
        const cmd = allowed[i];
        if (cmd.type !== "itemadd") continue;
        const hasPriorDelete = allowed.slice(0, i).some(prev =>
          (prev.type === "itemdelall" && prev.memberNumber === cmd.memberNumber) ||
          (prev.type === "itemdel" && prev.memberNumber === cmd.memberNumber && (
            constraints.replaceExisting || !cmd.part || !prev.part || prev.part === cmd.part
          ))
        );
        if (!hasPriorDelete) {
          allowed.splice(i, 1);
          rejected.push({ cmd, reason: "replacement-missing-prior-delete" });
        }
      }
    }
    return { allowed, rejected };
  }

  // 供浏览器现场回归读取；不暴露密钥或底层执行函数。
  window.__misakaPlanDebug = { filterCommandsByPlan, parseActionCommands };

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

  async function verifyActionOutcome(plan, commands) {
    if (!plan?.goal || !Array.isArray(commands) || commands.length === 0) return { satisfied: null, reason: "no-goal" };
    // 这是对规划器结构化 goal 的 canonical invariant 校验，不负责从原始自然语言猜意图。
    // 驷马缚必须出现真正的 Hogtie 样式设置；仅在四肢随便加几根绳或顺带加口塞不能算完成。
    if (/驷马缚|hogtie/i.test(plan.goal)) {
      const hasHogtieStyle = commands.some(cmd =>
        cmd?.type === "itemset" && /hogtie/i.test(String(cmd.value || ""))
      );
      if (!hasHogtieStyle) return { satisfied: false, reason: "没有设置有效的 Hogtie/驷马缚样式" };
      const unrelated = commands.find(cmd =>
        ["itemadd", "itemdel", "itemset", "itemcolor"].includes(cmd?.type) &&
        ["Mouth", "Head", "Neck", "Breast", "Vulva"].includes(cmd?.part)
      );
      if (unrelated) return { satisfied: false, reason: `夹带了与驷马缚无关的 ${unrelated.part} 操作` };
    }
    const finalFacts = buildCurrentAppearanceFacts(plan);
    if (!finalFacts) return { satisfied: null, reason: "no-final-state" };
    const prompt = `你是 BC 操作结果验收器。只输出一行严格 JSON，不要 markdown，不要回复用户。
根据用户目标、明确限制、实际执行指令和执行后的实时 Appearance，严格判断最终状态是否真正达到目标。
命名姿势、替换、不要叠加、不要新增等语义必须完整满足；只完成一部分时 satisfied=false。SimpleHogtie/Hogtied 等确实属于 Hogtie 的有效样式，但仅添加普通四肢绳索、不设置 Hogtie 样式不算驷马缚。目标未要求的口塞、头部或颈部操作属于夹带，也应判 false。
不要因为指令看起来合理就判成功，必须以最终 Appearance 为准。
格式:{"satisfied":true,"reason":"简短原因"}
计划:${JSON.stringify({ goal: plan.goal, constraints: plan.constraints || {}, operations: plan.operations || [] })}
实际执行:${JSON.stringify(commands)}
${finalFacts}`;
    const result = await callLLM(prompt, [{ role: "user", content: "验收本轮最终状态。" }], { thinking: true, maxTokens: 1024 });
    try {
      const match = String(result || "").match(/\{[\s\S]*\}/);
      const verdict = JSON.parse(match ? match[0] : "");
      if (typeof verdict.satisfied !== "boolean") throw new Error("invalid verdict");
      return { satisfied: verdict.satisfied, reason: String(verdict.reason || "").slice(0, 200) };
    } catch (e) {
      console.warn("[MisakaChat] 最终状态语义验收失败:", e.message, result);
      return { satisfied: null, reason: "verifier-failed" };
    }
  }

  function findItemByPart(char, itemName, part) {
    if (!char) return null;
    const searchName = itemName;
    // 限定部位
    if (part) {
      const groups = BODY_PART_GROUPS[part];
      if (groups) {
        for (const g of groups) {
          const item = char.Appearance.find(a =>
            a?.Asset?.Group?.Name === g &&
            (a?.Asset?.Name === searchName || a?.Asset?.Name === itemName ||
             a?.Asset?.Description === searchName || a?.Asset?.Description === itemName ||
             a?.Asset?.Description?.includes(searchName) || a?.Asset?.Description?.includes(itemName))
          );
          if (item) return item;
        }
      }
    }
    // 不限定部位 - 精确匹配
    let target = char.Appearance.find(a =>
      a?.Asset?.Group?.Name?.startsWith("Item") &&
      (a?.Asset?.Name === searchName || a?.Asset?.Description === searchName)
    );
    if (!target && searchName !== itemName) {
      target = char.Appearance.find(a =>
        a?.Asset?.Group?.Name?.startsWith("Item") &&
        (a?.Asset?.Name === itemName || a?.Asset?.Description === itemName)
      );
    }
    // 包含匹配
    if (!target) target = char.Appearance.find(a =>
      a?.Asset?.Group?.Name?.startsWith("Item") &&
      (a?.Asset?.Description?.includes(searchName) || a?.Asset?.Description?.includes(itemName))
    );
    return target;
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
      if (!target) {
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

  function executeItemAdd(memberNumber, itemName, part, color) {
    try {
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
      if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return { ok: false, reason: "missing-character" }; }
      const mapping = findItemAsset(itemName, char);
      if (!mapping) { console.log("[MisakaChat] 未知道具:", itemName); return { ok: false, reason: "unknown-item", memberNumber, item: itemName }; }
      if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return { ok: false, reason: "missing-character" }; }

      // 找目标 group
      const candidateGroups = part ? (BODY_PART_GROUPS[part] || []) : [];
      let targetGroup;
      if (part && candidateGroups.length > 0) {
        targetGroup = findEmptyGroup(char, candidateGroups, mapping.asset);
        // 明确指定了身体部位时绝不回退到该道具的默认 group。过去 HempRope:Hands
        // 会静默落到 ItemFeet，造成“说绑手、实际绑脚”。
        if (!targetGroup) return { ok: false, reason: "incompatible-part", memberNumber, item: itemName, part };
      } else if (part) {
        return { ok: false, reason: "unknown-part", memberNumber, item: itemName, part };
      } else {
        targetGroup = char.Appearance.find(a => a.Asset?.Group?.Name === mapping.group)
            ? (findEmptyGroup(char, [mapping.group, ...Asset.filter(a => a?.Group?.Name?.startsWith("Item") && a.Name === mapping.asset && a.Group.Name !== mapping.group).map(a => a.Group.Name)], mapping.asset) || mapping.group)
            : mapping.group;
      }
      let targetAsset = AssetGet(char.AssetFamily, targetGroup, mapping.asset);
      if (!targetAsset) return { ok: false, reason: "unknown-item", memberNumber, item: itemName };

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
      if (!target) {
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
    if (!text) return false;
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
        for (const p of parts) { if (!p) continue; setTimeout(() => { ElementValue("InputChat", p); ChatRoomSendChat(); }, delay); delay += 600; }
      } else { ElementValue("InputChat", parts[0] || text); ChatRoomSendChat(); }
      if (state.recentMessages.length > CONFIG.maxContext) state.recentMessages.shift();
    }
    return true;
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

  // Tool Policy: 检测危险操作,通知玩家但不拦截
  function checkToolPolicy(cmd) {
    // 对真人的道具操作和移动视为危险操作
    const selfMn = Player?.MemberNumber;
    // EMOTE: 无危险,直接放行
    if (cmd.type === "emote") return { ok: true, dangerous: false };
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
        sendLocal(`⚠️ 御坂即将对真人 ${who} 执行 ${actionDesc} 操作`);
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
      if (readableContent.length >= 15) {
        storeSemanticMemory(`御搬: ${readableContent}`, { sender: "御搬", memberNum: Player.MemberNumber, isSelf: true }).catch(() => {});
      }
      return;
    }

    const senderChar = ChatRoomCharacter.find(c => c.MemberNumber === senderNum);
    const senderName = (senderChar?.Nickname || senderChar?.Name) || ("#" + senderNum);
    // 判断是否为垃圾消息
    const noise = isNoise(data.Type, content, senderName);


    // 垃圾消息:不进上下文、不推动 messageCount
    if (noise) return;

    updateProfile(senderNum, senderName, readableContent);
    state.recentMessages.push({ senderName: senderName, content: readableContent, senderMemberNumber: senderNum, isSelf: false, time: now });
    if (state.recentMessages.length > CONFIG.maxContext) state.recentMessages.shift();
    state.lastNonSelfMsgTime = now;

    // 所有非噪音消息都存语义记忆(不只是触发回复的)
    if (readableContent.length >= 15) {
      storeSemanticMemory(`${senderName}: ${readableContent}`, { sender: senderName, memberNum: senderNum }).catch(() => {});
    }

    state.messageCount++;
    try { localStorage.setItem("misaka_msg_count", String(state.messageCount)); } catch(e) {}


    // 触发长期记忆提炼
    if (state.messageCount % CONFIG.memoryRefineInterval === 0) {
      maybeRefineMemory().catch(e => console.warn("[MisakaChat] refine error:", e.message));
    }


    // trigger 检测用原始 content 和可读 content 都匹配
    const triggers = ["misaka","御搬","御坂","misaki的","搬运工"];
    const lower = content.toLowerCase();
    const readableLower = readableContent.toLowerCase();
    const triggered = triggers.some(t => lower.includes(t.toLowerCase()) || readableLower.includes(t.toLowerCase()));
    if (!triggered) return;
    if (state.busy || window.__misakaGlobalBusy || window.__misakaReplyInProgress) return;

    const nowTime = Date.now();
    if (nowTime - state.lastReplyTime < CONFIG.cooldownMs) return;
    const lastUserTime = state.lastUserReplyTime[senderNum] || 0;
    if (nowTime - lastUserTime < CONFIG.perUserCooldownMs) return;

    window.__misakaGlobalBusy = true;
    window.__misakaReplyInProgress = true;

    const replyTimeout = setTimeout(() => {
      console.error("[MisakaChat] 回复硬超时");
      state.busy = false;
      window.__misakaGlobalBusy = false;
      window.__misakaReplyInProgress = false;
    }, CONFIG.replyHardTimeoutMs);

    handleReply(senderNum, senderName, readableContent).finally(() => clearTimeout(replyTimeout));
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

  function sanitizeReply(reply) {
    let cleaned = String(reply || "").replace(/^["""''''']+|["""''''']+$/g, "").trim();

    // thinking 模式下思考过程在 reasoning_content 里,content 是干净的回复
    // 这里只做格式处理:按行分割、兼容旧 | 格式、清理孤立 *
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

    const result = unescapeHTML(cleaned.slice(0, 120));
    return result;
  }

  async function handleReply(senderNum, senderName, content) {
    const debugId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.busy = true;
    window.__misakaGlobalBusy = true;
    state.lastReplyTime = Date.now();
    state.lastUserReplyTime[senderNum] = Date.now();
    pushDebugTrace({ id: debugId, stage: "start", senderNum, senderName, content });

    try {
      await new Promise(r => setTimeout(r, CONFIG.replyDelayMs));

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
      const requestPlan = await planUserRequest(senderNum, senderName, content);
      pushDebugTrace({ id: debugId, stage: "plan", requestPlan });
      // 规划器自身失败时不要再让主模型自由发挥。否则安全层虽会拦截指令，
      // 自然语言回复仍可能谎称操作成功。
      if (requestPlan.failed) {
        const clarification = requestPlan.question || "我没确认好具体操作，能再说具体一点吗？";
        pushDebugTrace({ id: debugId, stage: "guard:planner-failed", finalReply: clarification });
        sendReply(clarification);
        pushDebugTrace({ id: debugId, stage: "sent", finalReply: clarification });
        return;
      }
      // clarify 是规划器已经做出的安全决定，直接使用它的问题。继续调用主模型会让
      // 主模型无视计划、口头声称“收紧好了”，即使所有指令都被执行层拦住。
      if (requestPlan.intent === "clarify") {
        const clarification = requestPlan.question || "我还没确认好具体目标或操作，能再说清楚一点吗？";
        pushDebugTrace({ id: debugId, stage: "guard:clarify", finalReply: clarification });
        sendReply(clarification);
        pushDebugTrace({ id: debugId, stage: "sent", finalReply: clarification });
        return;
      }
      const needCatalog = requestPlan.intent === "action" && !!requestPlan.needsCatalog;
      const currentAppearanceFacts = buildCurrentAppearanceFacts(requestPlan);
      let systemPrompt = getSystemPrompt(needCatalog) +
        `\n\n【本轮结构化操作计划】\n${JSON.stringify(requestPlan)}\n` +
        `${currentAppearanceFacts ? `\n${currentAppearanceFacts}\n` : ""}` +
        `必须以 goal 的最终状态和 constraints 为准。当前实时 Appearance 高于历史对话；不得根据历史声称某道具现在仍存在。` +
        `ITEMSET 的值必须来自该道具在目标 group 的精确清单，绝不能把 Arms 的样式套到 Legs/Feet。LeatherDeluxeCuffs 只能放 Arms。命名姿势必须真正设置对应样式，不能只加普通绳索或夹带口塞来冒充。` +
        `只能生成计划 operations 所允许的类型、目标和明确部位。复合操作必须按真实执行顺序输出（例如替换必须先 ITEMDEL 再 ITEMADD，随后才能 ITEMSET）。` +
        `计划外动作一律不要输出；不得自行附加移动、表情或其他操作。intent=clarify 时只追问，intent=chat 时只聊天。`;
      console.log(`[MisakaChat] system prompt 构建完成(意图: ${requestPlan.intent}, 完整道具清单: ${needCatalog ? "是" : "否"})`);

      let reply = await callLLM(systemPrompt, contextMessages);
      pushDebugTrace({ id: debugId, stage: "llm:first", reply });
      if (reply) {
        const firstPass = parseActionCommands(reply);
        pushDebugTrace({ id: debugId, stage: "parse:first", commands: firstPass.commands, cleaned: firstPass.cleaned });
        const memCommands = firstPass.commands.filter(c => c.type === "memsearch");
        const bceCommands = firstPass.commands.filter(c => c.type === "bcequery");
        // 兜底:用户说"查一下XXX"但 LLM 没输出 BCEQUERY 时,自动提取查询目标
        const queryPattern = /(?:查(?:一查|一下|查)?|搜(?:一搜|一下)?|找(?:一找|一下)?)\s*([\u4e00-\u9fff\w]{2,20})/i;
        const queryMatch = content.match(queryPattern);
        if (bceCommands.length === 0 && queryMatch && queryMatch[1] && !/房间|名单|记录|道具|窝窝|颜色|几点|时间|状态/.test(queryMatch[1])) {
          const queryTarget = queryMatch[1].trim();
          console.log(`[MisakaChat] 自动触发 BCEQUERY 兜底: ${queryTarget}`);
          bceCommands.push({ type: "bcequery", target: queryTarget });
        }
        if (memCommands.length > 0 || bceCommands.length > 0) {
          let extraContext = "";
          if (memCommands.length > 0) {
            extraContext += await buildMemorySearchContext(memCommands);
          }
          if (bceCommands.length > 0) {
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
          }
          reply = await callLLM(systemPrompt + extraContext, contextMessages);
          pushDebugTrace({ id: debugId, stage: "llm:extra-context", reply });
        }
      }
      if (!reply) { console.warn("[MisakaChat] LLM 返回空,未回复");
        pushDebugTrace({ id: debugId, stage: "empty-reply" });
        return;
      }

      // 明确要求执行操作、但首轮没有任何可执行指令时，强制纠错一次。
      // 这比把自然语言“好了”当成功更安全，也覆盖绑第三人和修改第三人道具的场景。
      const initialParsed = parseActionCommands(reply);
      const initialExecutable = filterCommandsByPlan(requestPlan, initialParsed.commands).allowed;
      if (requestPlan.intent === "action" && initialExecutable.length === 0) {
        pushDebugTrace({ id: debugId, stage: "retry:no-action-command", reply });
        const correctionPrompt = `${systemPrompt}\n\n【本轮强制纠错】\n用户明确要求你执行操作，但你上一稿没有输出任何可执行指令。必须根据当前名单和道具清单，在第一行输出正确的 [ITEMADD:...] / [ITEMDEL:...] / [ITEMSET:...] / [ITEMCOLOR:...] / [MOVE:...] 等指令，然后第二行回复。若目标、部位或道具确实无法确定，只能直接追问，绝不能用动作描写或口头声称已经完成。`;
        const retryReply = await callLLM(correctionPrompt, contextMessages, { thinking: false });
        if (retryReply) {
          reply = retryReply;
          pushDebugTrace({ id: debugId, stage: "llm:action-retry", reply });
        }
      }

      // 解析操作指令
      const { commands, cleaned } = parseActionCommands(reply);
      const planFiltered = filterCommandsByPlan(requestPlan, commands);
      const executableCommands = planFiltered.allowed;
      let finalReply = sanitizeReply(cleaned);
      let commandResult = null;  // 提前声明,避免 TDZ
      pushDebugTrace({ id: debugId, stage: "parse:final", commands, executableCommands, rejectedCommands: planFiltered.rejected, cleaned, finalReply });

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
        const itemMutationTypes = new Set(["itemadd", "itemdel", "itemdelall", "itemset", "itemcolor", "snapshotRestore", "copyRestraint"]);
        const itemMutationCount = executableCommands.filter(cmd => itemMutationTypes.has(cmd.type)).length;
        // 任何多步道具操作都必须原子化。否则“先添加、后设样式”中后一步失败时，
        // 会留下半成品，却又只能对用户说本轮失败。单步操作无需额外快照。
        const transactionalReplacement = itemMutationCount > 1 || !!(requestPlan.constraints?.replaceExisting || requestPlan.constraints?.noStack);
        const replacementBackups = new Map();
        if (transactionalReplacement) {
          for (const mn of new Set(executableCommands.map(commandPrimaryTarget).filter(Number.isFinite))) {
            const char = Number(mn) === Number(Player?.MemberNumber)
              ? Player
              : (ChatRoomCharacter || []).find(c => Number(c.MemberNumber) === Number(mn));
            if (char && typeof CharacterAppearanceStringify === "function") {
              replacementBackups.set(Number(mn), CharacterAppearanceStringify(char));
            }
          }
        }
        const transactionUpdates = transactionalReplacement ? new Map() : null;
        if (transactionUpdates) deferredCharacterUpdates = transactionUpdates;
        try {
          commandResult = await executeCommands(executableCommands);
          console.log("[MisakaChat] 操作执行:", executableCommands, commandResult);
          pushDebugTrace({ id: debugId, stage: "execute", executableCommands, commandResult });
          if (transactionalReplacement && (commandResult.failures || []).length > 0 && replacementBackups.size > 0) {
            for (const [mn, backup] of replacementBackups) {
              const char = Number(mn) === Number(Player?.MemberNumber)
                ? Player
                : (ChatRoomCharacter || []).find(c => Number(c.MemberNumber) === Number(mn));
              if (!char) continue;
              CharacterAppearanceRestore(char, backup);
              updateCharacter(char);
            }
            commandResult.rolledBack = true;
            finalReply = "替换过程中有一步失败，已经恢复原样。";
            pushDebugTrace({ id: debugId, stage: "execute:rollback", reason: "item-batch-failed" });
          }
          // 多步请求不只要求“每条已生成指令成功”，还必须完整达到用户目标。
          // 主模型若漏掉后续子任务，验收器会判 false；此时同样按事务回滚，
          // 且仍处于 deferredCharacterUpdates 中，只向服务器同步一次恢复后的最终状态。
          if ((commandResult.failures || []).length === 0) {
            const postExecutionAppearance = buildCurrentAppearanceFacts(requestPlan);
            commandResult.outcomeVerdict = await verifyActionOutcome(requestPlan, executableCommands);
            pushDebugTrace({ id: debugId, stage: "verify:outcome", outcomeVerdict: commandResult.outcomeVerdict, finalAppearance: postExecutionAppearance });
            if (transactionalReplacement && commandResult.outcomeVerdict.satisfied === false && replacementBackups.size > 0) {
              for (const [mn, backup] of replacementBackups) {
                const char = Number(mn) === Number(Player?.MemberNumber)
                  ? Player
                  : (ChatRoomCharacter || []).find(c => Number(c.MemberNumber) === Number(mn));
                if (!char) continue;
                CharacterAppearanceRestore(char, backup);
                updateCharacter(char);
              }
              commandResult.rolledBack = true;
              commandResult.rollbackReason = "outcome-unsatisfied";
              const reason = commandResult.outcomeVerdict.reason ? `（${commandResult.outcomeVerdict.reason}）` : "";
              finalReply = `操作没有完整达到你要的效果${reason}，已经恢复原样。`;
              pushDebugTrace({ id: debugId, stage: "execute:rollback", reason: "outcome-unsatisfied", restoredAppearance: buildCurrentAppearanceFacts(requestPlan) });
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
          // 未分类失败也必须覆盖模型原先的“好了”等成功话术。
          else finalReply = `操作没有成功：${String(reason).slice(0, 120)}`;
        }
        if (commandResult.rolledBack && commandResult.rollbackReason !== "outcome-unsatisfied") finalReply = "操作过程中有一步失败，已经恢复原样。";
        if ((commandResult.failures || []).length === 0) {
          const outcomeVerdict = commandResult.outcomeVerdict || { satisfied: null, reason: "verification-missing" };
          if (outcomeVerdict.satisfied === false) {
            if (!commandResult.rolledBack) {
              const reason = outcomeVerdict.reason ? `（${outcomeVerdict.reason}）` : "";
              finalReply = `操作执行了，但还没完整达到你要的效果${reason}。`;
            }
          } else if (outcomeVerdict.satisfied !== true) {
            finalReply = "操作已经执行，但结果验收没有完成，我先不把它算作成功。";
          }
        }
      }

      // 如果只有指令没有文字回复,用默认回复
      if (!finalReply && executableCommands.length > 0) {
        const defaultReplies = ["好了~", "搞定了", "嗯,处理好了", "弄好了~", "已经调好了"];
        finalReply = defaultReplies[Math.floor(Math.random() * defaultReplies.length)];
      }
      if (!finalReply) return;

      // 存语义记忆(有意义的对话才存)
      if (finalReply.length > 3) {
        const memText = `${senderName}: ${content} → 御坂: ${finalReply}`;
        storeSemanticMemory(memText, { sender: senderName, memberNum: senderNum }).catch(() => {});
      }

      sendReply(finalReply);
      pushDebugTrace({ id: debugId, stage: "sent", finalReply });

    } catch (e) {
      console.error("[MisakaChat] 回复失败:", e.message);
      pushDebugTrace({ id: debugId, stage: "error", error: e.message });
    } finally {
      state.busy = false;
      window.__misakaGlobalBusy = false;
      window.__misakaReplyInProgress = false;
    }
  }

  // === [Commands] /misaka 命令系统 ===
  function handleCommand(msg) {
    if (!msg || !msg.startsWith("/misaka")) return false;
    const cmd = msg.slice("/misaka".length).trim();
    const parts = cmd.split(/\s+/);
    const sub = parts[0];
    if (sub === "on") { CONFIG.enabled = true; sendLocal("✅ 自动回复已开启"); }
    else if (sub === "off") { CONFIG.enabled = false; sendLocal("⏹ 自动回复已关闭"); }
    else if (sub === "key" && parts[1]) { localStorage.setItem(storageKey("apikey"), parts[1]); sendLocal("🔑 API key 已保存"); }
    else if (sub === "embedkey" && parts[1]) { localStorage.setItem("misaka_openrouter_key", parts[1]); sendLocal("🔎 OpenRouter embedding key 已保存"); }
    else if (sub === "model" && parts[1]) { localStorage.setItem(storageKey("model"), parts[1]); CONFIG.model = parts[1]; sendLocal("🤖 模型已切换: " + parts[1]); }
    else if (sub === "status") {
      const key = getApiKeyStatus();
      const embed = getEmbeddingProviderStatus();
      sendLocal(`状态: ${CONFIG.enabled?"开启":"关闭"} | 版本 ${SCRIPT_VERSION} ${RELEASE_CHANNEL} / loader ${window.__misakaUserLoaderLoaded || "手动"} | key ${key.source} | 模型 ${CONFIG.model} | embedding ${embed.provider.name}/${embed.provider.model} via ${embed.key.source} | 语义 ${state.semanticMemories.length} | 提炼 ${state.refinedMemories.length} | 认识 ${Object.keys(loadMemory().profiles||{}).length} 人`);
    } else if (sub === "forget") {
      localStorage.setItem(storageKey("memory"), "{}");
      state.semanticMemories = [];
      state.refinedMemories = [];
      IDB.clearAll();
      sendLocal("🧹 记忆已清空(含 IndexedDB 语义记忆)");
    }
    else if (sub === "export") {
      IDB.exportAll().then(data => {
        window.__misakaExportData = JSON.stringify(data);
        console.log("[MisakaChat] 导出数据已存入 window.__misakaExportData");
        sendLocal(`📦 已导出 ${data.semantic.length} 语义 + ${data.refined.length} 提炼到控制台`);
      });
    }
    else if (sub === "import") {
      const blob = window.__misakaExportData;
      if (!blob) { sendLocal("❌ 没有找到导出数据(先 export)"); }
      else {
        try {
          const data = JSON.parse(blob);
          IDB.importAll(data).then(() => {
            state.semanticMemories = data.semantic || [];
            state.refinedMemories = data.refined || [];
            sendLocal(`✅ 已导入 ${data.semantic?.length || 0} 语义 + ${data.refined?.length || 0} 提炼`);
          });
        } catch(e) { sendLocal("❌ 导入失败: " + e.message); }
      }
    }
    else if (sub === "memory") {
      const mem = loadMemory();
      const profiles = Object.entries(mem.profiles || {});
      if (profiles.length === 0) sendLocal("记忆为空");
      else profiles.forEach(([mn, info]) => sendLocal(`  ${info.name} (#${mn}): ${info.chatCount||0}次 | ${info.lastChat||""}`));
    } else if (sub === "persona" && parts[1]) {
      localStorage.setItem(storageKey("persona_extra"), parts.slice(1).join(" "));
      sendLocal("📝 人设附加备注已更新");
    } else {
      sendLocal("用法: /misaka on|off|key <key>|embedkey <openrouter-key>|model <name>|status|forget|memory|persona <text>|export|import");
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
    if (typeof Player === "undefined" || !Player) { setTimeout(init, 1000); return; }
    if (Player.MemberNumber !== 194331) { console.log("[MisakaChat] 非御坂账号,跳过"); return; }
    const savedModel = localStorage.getItem(storageKey("model")) || "";
    if (savedModel) CONFIG.model = savedModel;

    const existingMods = bcModSdk.getModsInfo();
    const existingMod = existingMods.find(m => m.name === "MisakaChat");
    let mod;
    if (existingMod) { console.log("[MisakaChat] mod 已注册"); mod = { hookFunction: () => {} }; }
    else {
      mod = bcModSdk.registerMod({ name: "MisakaChat", fullName: "Misaka Auto Chat v2", version: SCRIPT_VERSION, repository: "https://github.com/Igallta/bc-gimp-sorter" });
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
    sendLocal(`御坂自动回复 ${SCRIPT_VERSION} 已加载`);
    startIdleTimer();
  }


  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(init, 2000);
  else window.addEventListener("load", () => setTimeout(init, 2000));
})();
