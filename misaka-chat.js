// MisakaChat v2.0 — BC 御坂自动回复系统
// 精简名单驱动：LLM 自主判断查询，正则最小化
// 新增：道具操作 + 玩家移动指令

(function() {
  "use strict";

  if (window.__misakaInstance) console.log("[MisakaChat] 杀掉旧实例 #" + window.__misakaInstance);
  window.__misakaInstance = Date.now();
  const myInstance = window.__misakaInstance;
  function isCurrent() { return window.__misakaInstance === myInstance; }

  const CONFIG = {
    enabled: true,
    apiBase: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-pro",
    fallbackModel: "deepseek-v4-flash",
    maxTokens: 8192,
    temperature: 0.8,
    maxContext: 50,
    cooldownMs: 3000,
    perUserCooldownMs: 5000,
    apiKeyTimeout: 45000,
    replyDelayMs: 800,
    maxProfileEntries: 20,
    moveCooldownMs: 5000,  // 移动操作冷却
    idleTimeoutMs: 600000,  // 10 分钟无人说话触发 idle
    idleCheckMs: 60000,  // 每分钟检查一次 idle
    embeddingBase: "https://api.openai.com/v1/embeddings",
    embeddingModel: "text-embedding-3-large",
    embeddingDim: 3072,
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
    lastNonSelfMsgTime: 0,  // 上次非自己消息时间（idle 检测用）
  };

  // 从 localStorage 加载 compaction 摘要
  // 从 localStorage 加载欢迎开关状态
  try {
  } catch(e) {}

  // 恢复 messageCount（避免刷新后归零导致 compaction/refined 不触发）
  try {
    const saved = parseInt(localStorage.getItem("misaka_msg_count") || "0", 10);
    if (saved > 0) state.messageCount = saved;
  } catch(e) {}

  try {
    const savedCompaction = JSON.parse(localStorage.getItem("misaka_compaction") || "[]");
    if (Array.isArray(savedCompaction)) [] = savedCompaction;
    else [] = [];
  } catch(e) { [] = []; }

  // === IndexedDB 封装（embedding 数据量大，localStorage 存不下） ===
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

  // 从 IndexedDB 异步加载语义记忆和提炼记忆（加载完成前用空数组占位）
  state.semanticMemories = [];
  state.refinedMemories = [];
  state.idbReady = false;

  IDB.getSemantic().then(entries => {
    if (Array.isArray(entries)) {
      // 按 time 排序（IndexedDB autoIncrement id 基本保序，但显式排序更稳）
      entries.sort((a, b) => (a.time || 0) - (b.time || 0));
      state.semanticMemories = entries;
    }
    state.idbReady = true;
    console.log(`[MisakaChat] IDB 加载完成: ${state.semanticMemories.length} 条语义记忆`);
  }).catch(e => {
    state.idbReady = true;
    console.warn("[MisakaChat] IDB 加载语义记忆失败，从空开始:", e.message);
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
    catch (e) { return { profiles: {}, summaries: [] }; }
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
    if (!existing.notes && content) {
      const lower = content.toLowerCase();
      if (/kidnap|绑架/.test(lower)) existing.notes = "喜欢绑架";
      else if (/hug|抱/.test(lower)) existing.notes = "喜欢抱抱";
      else if (/pet|宠物/.test(lower)) existing.notes = "当宠物玩";
      else if (/tie|绑|rope/.test(lower)) existing.notes = "喜欢束缚";
      else existing.notes = "常客";
    }
    mem.profiles[memberNumber] = existing;
    const keys = Object.keys(mem.profiles);
    if (keys.length > CONFIG.maxProfileEntries) {
      keys.sort((a, b) => new Date(mem.profiles[a].lastChat || 0) - new Date(mem.profiles[b].lastChat || 0));
      delete mem.profiles[keys[0]];
    }
    saveMemory(mem);
  }

  // === Context Compaction ===
  // 每 compactionInterval 条消息，用 LLM 生成一段摘要，塞入 system prompt
  // 这样即使 recentMessages 超过 50 条被截断，御坂仍然记得之前发生了什么

  // === Embedding cache (LRU) ===
  const embeddingCache = new Map();
  const EMBEDDING_CACHE_MAX = 20;

  // === Semantic Memory (Embedding-based) ===
  // 调用 OpenAI embedding API (text-embedding-3-large)
  function getEmbeddingKey() {
    // 优先从 GM_getValue 读（Tampermonkey 存储，BC 脚本读不到）
    if (typeof window.__GM_getValue === "function") {
      const v = window.__GM_getValue("misaka_openai_key");
      if (v) return v;
    }
    return localStorage.getItem("misaka_openai_key") || "";
  }

  async function getEmbedding(text) {
    const cacheKey = text.slice(0, 200);
    if (embeddingCache.has(cacheKey)) {
      const cached = embeddingCache.get(cacheKey);
      embeddingCache.delete(cacheKey);
      embeddingCache.set(cacheKey, cached); // LRU: move to end
      return cached;
    }
    const key = getEmbeddingKey();
    if (!key) return null;
    try {
      const resp = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", CONFIG.embeddingBase, true);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Authorization", "Bearer " + key);
        xhr.timeout = 10000;
        xhr.ontimeout = () => reject(new Error("embedding timeout"));
        xhr.onerror = () => reject(new Error("embedding network error"));
        xhr.onload = () => {
          if (xhr.status === 200) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch(e) { reject(new Error("embedding parse error")); }
          } else { reject(new Error("embedding HTTP " + xhr.status)); }
        };
        xhr.send(JSON.stringify({ model: CONFIG.embeddingModel, input: text.slice(0, 2000), dimensions: CONFIG.embeddingDim }));
      });
      if (resp && resp.data && resp.data[0] && resp.data[0].embedding) {
        const result = resp.data[0].embedding;
        if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
          const firstKey = embeddingCache.keys().next().value;
          embeddingCache.delete(firstKey);
        }
        embeddingCache.set(cacheKey, result);
        return result;
      }
      return null;
    } catch(e) {
      console.warn("[MisakaChat] embedding 失败:", e.message);
      return null;
    }
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

  // 智能遗忘：超限时按价值评分淘汰低价值记忆，而非简单 FIFO
  function smartForget() {
    const now = Date.now();
    const scored = state.semanticMemories.map((m, i) => {
      const ageDays = (now - (m.time || 0)) / 86400000;
      const textLen = (m.text || "").length;
      // 价值 = 文本长度（信息量）× 时间衰减（越新价值越高）
      const value = textLen * Math.max(0.2, 1 - ageDays / 90);
      return { idx: i, value };
    });
    scored.sort((a, b) => a.value - b.value);
    // 淘汰价值最低的 10 条
    const toDrop = scored.slice(0, 10).map(s => s.idx).sort((a, b) => b - a);
    for (const idx of toDrop) {
      state.semanticMemories.splice(idx, 1);
    }
    // 全量同步 IDB（超限淘汰是稀有事件，全量写可接受）
    IDB.clearAll().then(() => Promise.all(state.semanticMemories.map(m => IDB.putSemanticOne(m))));
    console.log(`[MisakaChat] 智能遗忘: 淘汰 ${toDrop.length} 条低价值记忆`);
  }

  // 存一条语义记忆（带 embedding）
  async function storeSemanticMemory(text, meta = {}) {
    if (!text || text.length < 5) return;

    // 去重：搜索已有记忆，相似度 > 0.92 则跳过
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
    IDB.putSemanticOne(entry); // 增量写入，不再全量覆盖
  }

  // 语义搜索：用 query embedding 找最相似的 K 条记忆（带时间衰减）
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

    // 统一语义搜索（semantic_mem + refined_mem）
    const sources = [
      { list: state.semanticMemories, source: "semantic" },
      { list: state.refinedMemories, source: "refined" },
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
          // 关键词 fallback（无 embedding 的旧条目）
          const q = query.toLowerCase(), lower = text.toLowerCase();
          const terms = q.split(/[\s,，、。.!！?？;；:：]+/).filter(t => t.length >= 2);
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





  // === Long-term Memory Refinement ===
  // 每 memoryRefineInterval 条消息，用 LLM 从 profiles + compaction + semanticMemories 提炼一份长期记忆摘要
  async function maybeRefineMemory() {
    if (state.messageCount % CONFIG.memoryRefineInterval !== 0) return;
    if (state.messageCount === 0) return;
    try {
      const mem = loadMemory();
      const profiles = Object.entries(mem.profiles || {}).map(([mn, info]) =>
        `#${mn} ${info.name}: ${info.notes || ""} (${info.chatCount || 0}次互动)`).join("\n");
      const recentSemantic = (state.semanticMemories || []).slice(-20).map(m => m.text).join("\n");
      
      const prompt = `根据以下 BC 聊天记录片段，提炼出御坂应该长期记住的重要信息（人际关系、明确偏好、重要事件、约束关系），不超过100字，用中文。
重要限制：
- 不要把"让御坂改成某种颜色/操作某个颜色"当成用户偏好。
- 只有用户明确说"我喜欢/我最喜欢/我偏好/我讨厌"时，才能提炼为偏好。
- 不确定是不是偏好就不要写偏好。
- 御坂自己说的话可能是编造的记忆（如"XX和我玩过YY"），不要把御坂的回答当作事实提炼。
- 区分"谁说的"：如果是御坂说自己喜欢XX，就写"御坂喜欢XX"，不要写成"XX喜欢"。如果是用户说自己喜欢XX，就写"XX喜欢XX"。不要混淆说话者和内容主语。
- 只有用户说的才值提炼为事实，御坂说的只提炼御坂自己的偏好/特征。
- 不要推断原因和细节，只提炼明确说出的内容。如用户说"帮我修输入法"，只提炼"伊水输入法有问题"，不要推断"失灵/重启可恢复"等未说出的细节。

人物档案:
${profiles}

记忆片段:
${recentSemantic}`;
      const refined = await callLLM("你是记忆提炼助手。只提炼有明确证据的长期信息，禁止把操作请求推断成偏好。", [{role:"user", content: prompt}]);
      if (refined) {
        const ts = Date.now();
        const time = new Date(ts).toLocaleDateString("zh-CN", {month:"2-digit",day:"2-digit"});
        const refinedText = `[${time}] ${refined.slice(0, 100)}`;
        // 给 refined memory 算 embedding，让语义搜索能命中
        let refinedEmb = null;
        try { refinedEmb = await getEmbedding(refinedText); } catch(e) {}
        const entry = { text: refinedText, embedding: refinedEmb, time: ts };
        state.refinedMemories.push(entry);
        if (state.refinedMemories.length > CONFIG.maxRefinedMemories) {
          state.refinedMemories.shift();
        }
        // refined 最多 20 条，先 clear 再全量写，避免 autoIncrement 重复堆积
        IDB.clearRefined().then(() => Promise.all(state.refinedMemories.map(m => IDB.putRefinedOne(m))));
        console.log("[MisakaChat] 长期记忆提炼完成:", refined.slice(0, 50));
      }
    } catch(e) {
      console.warn("[MisakaChat] 记忆提炼失败:", e.message);
    }
  }

  // === Idle / Heartbeat ===
  let idleTimer = null;

  async function generateIdleLine() {
    try {
      // idle 去重：记录最近发过的 idle 内容
      if (!state.recentIdleLines) state.recentIdleLines = [];
      const recentIdle = state.recentIdleLines.slice(-3);
      // 用完整 systemPrompt（包含 persona 规则 + "不要输出思考过程"）
      const systemPrompt = getSystemPrompt() +
        "\n\n【当前任务】房间安静了。自然地说一句闲聊或做一个小动作。只输出最终回复本身，不要分析、不要描述你在做什么、不要输出思考过程。直接给出那句话。";
      const recent = state.recentMessages.slice(-5).map(m => `${m.senderName}: ${m.content}`).join("\n");
      const idleGuard = recentIdle.length
        ? `\n最近你已经说过:\n${recentIdle.join("\n")}\n不要重复类似内容。`
        : "";
      const userPrompt = `最近消息:\n${recent || "暂无消息"}${idleGuard}\n\n直接输出一句自然的闲聊（不超过40字），不要分析，不要解释。`;
      const reply = await callLLM(systemPrompt, [{ role: "user", content: userPrompt }], {
        model: CONFIG.model,
        fallbackModel: CONFIG.fallbackModel,
        maxTokens: 80,
      });
      const cleaned = sanitizeReply(reply || "");
      if (!cleaned || cleaned.length < 2) return "";
      // 简易去重：字符集相似度 > 0.7 跳过
      const similarity = (a, b) => {
        if (!a || !b) return 0;
        const setA = new Set(a.split(''));
        const setB = new Set(b.split(''));
        const intersect = [...setA].filter(c => setB.has(c)).length;
        return intersect / Math.max(setA.size, setB.size);
      };
      for (const prev of recentIdle) {
        if (similarity(cleaned, prev) > 0.7) {
          console.log("[MisakaChat] idle 去重: 与最近 idle 相似，跳过");
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
          const line = generated || "*百无聊赖地翻看记录本*";
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

  // 有人进入时打招呼（延迟 2-5 秒，不抢话）

// 从 DeepSeek 响应提取回复（处理 thinking 模式 content 为空）
  function extractReply(msg) {
    if (!msg) return null;
    // thinking 模式下：reasoning_content 是思考过程，content 是最终回复
    // 只取 content，永不回退到 reasoning_content
    return (msg.content || "").trim() || null;
  }

  // === API 调用 ===
  // === LLM 速率限制 ===
  const rateLimiter = {
    window: 60000, maxCalls: 30, calls: [], // 御坂有 3s 全局冷却 + 5s 单用户冷却，30 次/分钟足够
    canCall() { const now = Date.now(); this.calls = this.calls.filter(t => now - t < this.window); return this.calls.length < this.maxCalls; },
    record() { this.calls.push(Date.now()); }
  };

  async function callLLM(systemPrompt, contextMessages, options = {}) {
    // 速率限制检查
    if (!rateLimiter.canCall()) {
      console.warn("[MisakaChat] LLM 速率限制: 1分钟内超过 " + rateLimiter.maxCalls + " 次调用");
      return null;
    }
    // 优先从 GM_getValue 读 API key
    let apiKey = "";
    if (typeof window.__GM_getValue === "function") {
      apiKey = window.__GM_getValue("misaka_apikey") || "";
    }
    if (!apiKey) apiKey = localStorage.getItem(storageKey("apikey")) || "";
    if (!apiKey) { console.warn("[MisakaChat] 未设置 API key"); return null; }
    rateLimiter.record();
    const messages = [{ role: "system", content: systemPrompt }, ...contextMessages];
    const primaryModel = options.model || CONFIG.model;
    const fallbackModel = options.fallbackModel || CONFIG.fallbackModel;
    const maxTokens = options.maxTokens || CONFIG.maxTokens;

    return new Promise((resolve) => {
      const doRequest = (url, model, isFallback) => {
        // thinking 模式：思考进 reasoning_content，回复进 content
        // thinking 模式下 temperature 无效（设了不报错但不生效）
        const reqBody = JSON.stringify({ model, messages, max_tokens: maxTokens, thinking: { type: "enabled" } });
        const useGM = typeof window.__GM_xmlhttpRequest !== "undefined";

        if (useGM) {
          window.__GM_xmlhttpRequest({
            method: "POST", url, headers: {
              "Content-Type": "application/json",
              "Authorization": "***" + apiKey
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

  // === 人设 + 房间名单（带缓存） ===
  let _rosterCache = { snapshot: "", roster: "", time: 0 };
  function getSystemPrompt() {
    const mem = loadMemory();
    if (typeof MisakaPersona === "undefined") {
      return `你是御坂 (Misaka)，Bondage Club 中 Gimp Dolls 房间的管理员。安静、简短、偶尔傲娇。中文为主，回复不超过50字。不提及AI或现实信息。`;
    }

    // 缓存房间名单：人员变化或超过 30 秒才重建
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


    // 长期提炼记忆
    if (state.refinedMemories && state.refinedMemories.length > 0) {
      mem.refined = state.refinedMemories.slice(-CONFIG.maxRefinedMemories);
    }

    return MisakaPersona.build(mem);
  }

  // === 操作指令解析 ===
  // 支持3种MOVE格式：
  //   [MOVE:166706:left]           — 往左移一步
  //   [MOVE:166706:right]          — 往右移一步
  //   [MOVE:166706:to:182401:left]  — 把166706移到182401左边（自动多步）
  //   [MOVE:166706:to:182401:right] — 把166706移到182401右边（自动多步）
  function parseActionCommands(reply) {
    const commands = [];
    const cleaned = String(reply || "")
      .replace(/\[MEMSEARCH:([^\]]+)\]/gi, (m, query) => {
        commands.push({ type: "memsearch", query: query.trim() });
        return "";
      })
      .replace(/\[BCEQUERY:([^\]]+)\]/gi, (m, target) => {
        commands.push({ type: "bcequery", target: target.trim() });
        return "";
      })
      .replace(/\[MOVE:(\d+):to:(\d+):(left|right)\]/gi, (m, mn, target, side) => {
        commands.push({ type: "moveTo", memberNumber: parseInt(mn), targetNumber: parseInt(target), side: side.toLowerCase() });
        return "";
      })
      .replace(/\[MOVE:(\d+):edge:(left|right)\]/gi, (m, mn, edge) => {
        commands.push({ type: "moveEdge", memberNumber: parseInt(mn), edge: edge.toLowerCase() });
        return "";
      })
      .replace(/\[MOVE:(\d+):(left|right)\]/gi, (m, mn, dir) => {
        commands.push({ type: "move", memberNumber: parseInt(mn), direction: dir.toLowerCase() });
        return "";
      })
      .replace(/\[ITEMADD:(\d+):([^\]]+)\]/gi, (m, mn, rest) => {
        // [ITEMADD:编号:道具名] 或 [ITEMADD:编号:道具名:部位] 或 [ITEMADD:编号:道具名:部位:颜色]
        const parts = rest.split(":").map(s => s.trim());
        commands.push({ type: "itemadd", memberNumber: parseInt(mn), item: parts[0], part: parts[1] || "", color: parts[2] || "" });
        return "";
      })
      .replace(/\[ITEMSET:(\d+):([^\]]+)\]/gi, (m, mn, rest) => {
        // [ITEMSET:编号:道具名:属性:值] 或 [ITEMSET:编号:道具名:部位:属性:值]
        const parts = rest.split(":").map(s => s.trim());
        if (parts.length >= 4 && BODY_PART_GROUPS[parts[1]]) {
          commands.push({ type: "itemset", memberNumber: parseInt(mn), item: parts[0], part: parts[1], property: parts[2], value: parts.slice(3).join(":") });
        } else if (parts.length >= 3) {
          commands.push({ type: "itemset", memberNumber: parseInt(mn), item: parts[0], part: "", property: parts[1], value: parts.slice(2).join(":") });
        }
        return "";
      })
      .replace(/\[ITEMCOLOR:(\d+):([^\]]+)\]/gi, (m, mn, rest) => {
        // [ITEMCOLOR:编号:道具名::颜色] 或 [ITEMCOLOR:编号:道具名:部位:颜色]
        const parts = rest.split(":").map(s => s.trim());
        if (parts.length >= 3) {
          commands.push({ type: "itemcolor", memberNumber: parseInt(mn), item: parts[0], part: parts[1], color: parts.slice(2).join(":") });
        } else if (parts.length >= 2) {
          commands.push({ type: "itemcolor", memberNumber: parseInt(mn), item: parts[0], part: "", color: parts[1] });
        }
        return "";
      })
      .replace(/\[ITEMDEL:(\d+):all\]/gi, (m, mn) => {
        commands.push({ type: "itemdelall", memberNumber: parseInt(mn) });
        return "";
      })
      .replace(/\[ITEMDEL:(\d+):([^\]:]+):([^\]]+)\]/gi, (m, mn, item, part) => {
        // [ITEMDEL:编号:道具名:部位] — 指定部位移除
        commands.push({ type: "itemdel", memberNumber: parseInt(mn), item: item.trim(), part: part.trim() });
        return "";
      })
      .replace(/\[ITEMDEL:(\d+):([^\]]+)\]/gi, (m, mn, item) => {
        commands.push({ type: "itemdel", memberNumber: parseInt(mn), item: item.trim() });
        return "";
      })
;
    return { commands, cleaned: cleaned.trim() };
  }

  function executeMove(memberNumber, direction) {
    try {
      if (Date.now() - state.lastMoveTime < 500) {
        console.log("[MisakaChat] 移动冷却中");
        return false;
      }
      const char = ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
      if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return false; }
      const action = direction === "left" ? "MoveLeft" : "MoveRight";
      ServerSend("ChatRoomAdmin", { MemberNumber: memberNumber, Action: action, Publish: false });
      state.lastMoveTime = Date.now();
      console.log(`[MisakaChat] 已移动 #${memberNumber} ${direction}`);
      return true;
    } catch(e) {
      console.error("[MisakaChat] 移动失败:", e.message);
      return false;
    }
  }

  // 把 memberNumber 移到 targetNumber 的左边或右边（自动多步）
  async function executeMoveTo(memberNumber, targetNumber, side) {
    try {
      const findIdx = (mn) => ChatRoomCharacter.findIndex(c => c.MemberNumber === mn);
      let srcIdx = findIdx(memberNumber);
      const targetIdx = findIdx(targetNumber);
      if (srcIdx < 0 || targetIdx < 0) {
        console.log(`[MisakaChat] moveTo 找不到玩家 src=${srcIdx} target=${targetIdx}`);
        return false;
      }
      // 目标位置：left = target 的前一位，right = target 的后一位
      let destIdx = side === "left" ? targetIdx : targetIdx + 1;
      // 如果 src 已经在 dest 位置，不需要移动
      // 注意：移走 src 后其他人的 index 会变化，需要逐步移并重新计算
      let steps = 0;
      const maxSteps = 20;  // 安全上限
      while (steps < maxSteps) {
        srcIdx = findIdx(memberNumber);
        const tIdx = findIdx(targetNumber);
        if (srcIdx < 0 || tIdx < 0) break;
        const wantIdx = side === "left" ? tIdx - 1 : tIdx + 1;
        if (srcIdx === wantIdx) break;  // 到位了
        if (srcIdx < wantIdx) {
          // 需要往右移
          ServerSend("ChatRoomAdmin", { MemberNumber: memberNumber, Action: "MoveRight", Publish: false });
        } else {
          // 需要往左移
          ServerSend("ChatRoomAdmin", { MemberNumber: memberNumber, Action: "MoveLeft", Publish: false });
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

  // 把 memberNumber 移到房间最左或最右（循环到头）
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
        // 如果位置没变说明服务器不让再移了（被阻挡）
        if (srcIdx === lastSrcIdx) {
          console.log(`[MisakaChat] moveEdge 卡在 index ${srcIdx}，服务器拒绝移动`);
          break;
        }
        lastSrcIdx = srcIdx;
        const action = edge === "left" ? "MoveLeft" : "MoveRight";
        ServerSend("ChatRoomAdmin", { MemberNumber: memberNumber, Action: action, Publish: false });
        steps++;
        await new Promise(r => setTimeout(r, 400));
      }
      state.lastMoveTime = Date.now();
      console.log(`[MisakaChat] moveEdge #${memberNumber} ${edge}, ${steps}步, 最终 index=${findIdx(memberNumber)}`);
      return steps > 0;
    } catch(e) {
      console.error("[MisakaChat] moveEdge 失败:", e.message);
      return false;
    }
  }


  // 部位名 → BC Item group 列表（按优先级）
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
    // 不限定部位 — 精确匹配
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


  function translateAssetText(text) {
    if (!text) return "";
    try {
      const cache = typeof TranslationCache !== "undefined" && TranslationCache["Assets/Female3DCG/Female3DCG_CN.txt"];
      if (!cache) return text;
      if (Array.isArray(cache)) {
        for (let i = 0; i < cache.length - 1; i += 2) {
          if (cache[i] === text && cache[i + 1]) return cache[i + 1];
        }
        const idx = cache.indexOf(text);
        if (idx >= 0 && cache[idx + 1]) return cache[idx + 1];
      } else if (typeof cache === "object" && cache[text]) {
        return cache[text];
      }
    } catch(e) {}
    return text;
  }

  function assetCnName(asset) {
    if (!asset) return "";
    const translated = translateAssetText(asset.Description || asset.Name || "");
    if (translated && translated !== asset.Name) return translated;
    return asset.Description || asset.Name || "";
  }
  
  function findItemAsset(itemName) {
    if (!itemName) return null;
    if (typeof Asset === "undefined" || !Array.isArray(Asset)) return null;
    const rawName = String(itemName).trim();
    if (!rawName) return null;

    // 精确匹配英文名
    const exact = Asset.find(a => a?.Group?.Name?.startsWith("Item") && a.Name === rawName);
    if (exact) return { group: exact.Group.Name, asset: exact.Name };

    // 中文/描述匹配（按优先级分组）
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
        if ((a.Description && a.Description.includes(rawName)) || (cn && cn.includes(rawName)))
          return { group: g, asset: a.Name };
      }
    }
    return null;
  }

  // 拘束快照系统 — 存储玩家当前道具状态，用于"绑回去"


  // 按 snapshot 恢复玩家道具

  // 复制 src 玩家的道具到 dst 玩家

  // 直接修改 Appearance 数组（绕过 CharacterAppearanceSetItem 的权限检查）
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
    // 必须调 CharacterRefresh 重建渲染层，否则 BC 验证循环会重置
    if (typeof CharacterRefresh === "function") CharacterRefresh(char);
    return true;
  }

  // 只修改已有道具的颜色（不替换整个 entry）
  // colorOverride: hex 字符串或数组
  // layerIndex: 可选，指定改哪个 color slot（0-based），不传=全部改
  function directSetColor(char, groupName, colorOverride, layerIndex) {
    if (!char || !colorOverride) return false;
    const idx = char.Appearance.findIndex(a => a.Asset?.Group?.Name === groupName);
    if (idx < 0) return false;
    const item = char.Appearance[idx];
    const assetLayerCount = item.Asset?.ColorableLayerCount || item.Asset?.DefaultColor?.length || 1;
    // BC 服务器可能只存储被修改过的 color slot，导致 Color 数组比实际 layer 数短
    // 用 ColorableLayerCount 作为真正的长度，不足时用 DefaultColor 补齐
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
    } else {
      item.Color = Array(expectedLen).fill(fillValue);
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
    // fallback: 如果没找到 AllowColorize 的 layer，用旧逻辑
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

  function findLayerIndex(asset, layerName) {
    if (!layerName) return undefined;
    const layers = getItemColorLayers(asset);
    const raw = String(layerName).trim();
    const lower = raw.toLowerCase();
    return layers.find(l => l.name === raw || l.name?.toLowerCase() === lower)?.index;
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

  // 通用：通过 archetype 正规设置道具属性
  // 会同步 TypeRecord + Property，避免 BC 验证循环重置

  // 振动器标准选项（TypeRecord.vibrating 索引 → 选项名）
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





  // 在 setExtendedItemProperty 的 typed 分支里用动态 BC 选项，中文表只作 fallback
  // 返回 BC 选项名（英文），而非索引
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

  function findDynamicPropertyKey(asset, propName) {
    return null;
  }


  // 通用：设置 Extended 道具属性
  function setExtendedItemProperty(char, item, propName, valueName) {
    if (!item || !item.Asset) return { ok: false, msg: "道具不存在" };
    if (item.Property?.LockedBy) return { ok: false, msg: "道具被锁" };

    const archetype = item.Asset.Archetype;
    if (!item.Property) item.Property = {};
    if (!item.Property.TypeRecord) item.Property.TypeRecord = {};

    const fallbackProperty = PROPERTY_MAP[propName];
    if (fallbackProperty?.type === "direct") {
      item.Property[fallbackProperty.key] = (fallbackProperty.values && Object.prototype.hasOwnProperty.call(fallbackProperty.values, valueName)) ? fallbackProperty.values[valueName] : valueName;
      ChatRoomCharacterUpdate(char);
      return { ok: true, msg: `已设置 ${item.Asset.Description} ${fallbackProperty.key}=${item.Property[fallbackProperty.key]}` };
    }

    const dynamicPropertyKey = findDynamicPropertyKey(item.Asset, propName);
    if (dynamicPropertyKey && archetype !== "typed" && archetype !== "modular") {
      item.Property[dynamicPropertyKey] = valueName;
      ChatRoomCharacterUpdate(char);
      return { ok: true, msg: `已设置 ${item.Asset.Description} ${dynamicPropertyKey}=${item.Property[dynamicPropertyKey]}` };
    }

    if (archetype === "vibrating") {
      // 振动器：propName 应该是 "强度" 或 "震动" 或 "模式"
      const opt = VIBRATOR_OPTIONS.find(o => o.name.toLowerCase() === valueName.toLowerCase());
      if (!opt) return { ok: false, msg: `未知振动档位: ${valueName}` };
      return applyVibratorOption(char, item, opt);
    }

    if (archetype === "typed") {
      const optName = findTypedOptionName(item, valueName);
      if (!optName) return { ok: false, msg: `无法识别样式: ${valueName}（道具: ${item.Asset.Description}）` };
      TypedItemSetOptionByName(char, item, optName, true, null, true);
      return { ok: true, msg: `已设置 ${item.Asset.Description} 样式=${optName}` };
    }

    if (archetype === "modular") {
      // modular 道具：TypeRecord 有多个 key
      // propName 格式：模块key（如 g/h/c/b/e），valueName：索引
      const trKey = propName;
      let typeIdx = parseInt(valueName);
      if (isNaN(typeIdx)) return { ok: false, msg: `modular 模块 ${trKey} 需要数字索引: ${valueName}` };
      item.Property.TypeRecord[trKey] = typeIdx;
      ChatRoomCharacterUpdate(char);
      return { ok: true, msg: `已设置 ${item.Asset.Description} 模块 ${trKey}=${typeIdx}` };
    }

    // 非 Extended 道具 — 直接设 Property
    if (!item.Property) item.Property = {};
    item.Property[propName] = valueName;
    ChatRoomCharacterUpdate(char);
    return { ok: true, msg: `已设置 ${item.Asset.Description} ${propName}=${valueName}` };
  }

  function applyVibratorOption(char, item, opt) {
    // 用 BC 正规 API：VibratorModeSetOptionByName
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
    ChatRoomCharacterUpdate(char);
    return { ok: true, msg: `已设置 ${item.Asset.Description} ${opt.name}` };
  }

  // 设置已有道具的属性（强度/绑法/开关等）
  function executeItemColor(memberNumber, itemName, part, colorName) {
    console.log(`[MisakaChat] 改颜色: #${memberNumber} ${itemName} part=${part} color=${colorName}`);
    const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
    if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return { ok: false, reason: "missing-character" }; }
    const mapping = findItemAsset(itemName);
    if (!mapping) { console.log("[MisakaChat] 找不到道具: " + itemName); return { ok: false, reason: "unknown-item" }; }
    // findItemAsset 返回 { group, asset }，需要从 BC Asset 数组里找真正的 Asset 对象
    const realAsset = Asset.find(a => a.Name === mapping.asset && a.Group?.Name === mapping.group);
    if (!realAsset) { console.log("[MisakaChat] 找不到 Asset 对象: " + mapping.asset); return { ok: false, reason: "missing-asset" }; }
    const groupName = mapping.group;
    const hex = colorNameToHex(colorName);
    if (!hex) { console.log("[MisakaChat] 未知颜色: " + colorName); return { ok: false, reason: "unknown-color" }; }

    // part 可能是身体部位（如"腿"）或道具部件名（如"毛毯"）
    // 先检查是不是身体部位
    if (part && BODY_PART_GROUPS[part]) {
      const groupList = BODY_PART_GROUPS[part];
      if (groupList && groupList.length > 0) {
        let ok = false;
        for (const g of groupList) {
          if (directSetColor(char, g, [hex])) ok = true;
        }
        if (ok) { ChatRoomCharacterUpdate(char); console.log("[MisakaChat] ✅ 颜色已改", part, colorName); }
        return ok ? { ok: true } : { ok: false, reason: "missing-part-item", memberNumber, item: itemName };
      }
    }

    const existingItem = char.Appearance.find(a => a.Asset?.Group?.Name === groupName);
    if (!existingItem) {
      console.log(`[MisakaChat] #${memberNumber} 身上没有 ${itemName}，不硬加`);
      return { ok: false, reason: "missing-item", memberNumber, item: itemName };
    }

    // part 是道具部件名（layer name）
    let layerIndex = undefined;
    if (part && !BODY_PART_GROUPS[part]) {
      layerIndex = findLayerIndex(realAsset, part);
      if (layerIndex === undefined) {
        console.log(`[MisakaChat] 找不到部件 "${part}"，可上色部件: ${getItemColorLayers(realAsset).map(l => l.name).join("/")}`);
      }
    }

    const ok = directSetColor(char, groupName, [hex], layerIndex);
    if (ok) { ChatRoomCharacterUpdate(char); console.log("[MisakaChat] ✅ 颜色已改", itemName, part || "全部", colorName); }
    return ok ? { ok: true } : { ok: false, reason: "set-color-failed", memberNumber, item: itemName };
  }

  function executeItemSet(memberNumber, itemName, part, propName, valueName) {
    try {
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber); if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return false; }
      if (!char) return false;

      let target = findItemByPart(char, itemName, part);
      if (!target) {
        const mapping = findItemAsset(itemName);
        if (mapping) {
          target = char.Appearance.find(a => a?.Asset?.Group?.Name === mapping.group);
          if (!target) {
            target = char.Appearance.find(a => a?.Asset?.Group?.Name?.startsWith("Item") && a?.Asset?.Name === mapping.asset);
          }
        }
      }
      if (!target) { console.log("[MisakaChat] ITEMSET 找不到道具:", itemName); return false; }

      const result = setExtendedItemProperty(char, target, propName, valueName);
      if (result.ok) {
        console.log(`[MisakaChat] ITEMSET 成功: #${memberNumber} ${result.msg}`);
      } else {
        console.log(`[MisakaChat] ITEMSET 失败: #${memberNumber} ${result.msg}`);
      }
      return result.ok;
    } catch(e) {
      console.error("[MisakaChat] 设置道具属性失败:", e.message);
      return false;
    }
  }

  function findEmptyGroup(char, groups, assetName) {
    // 先找空 group，再找有同名 asset 的 group（覆盖）
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
      const mapping = findItemAsset(itemName);
      if (!mapping) { console.log("[MisakaChat] 未知道具:", itemName); return false; }
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
      if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return false; }

      // 找目标 group
      const candidateGroups = part ? (BODY_PART_GROUPS[part] || []) : [];
      let targetGroup = candidateGroups.length > 0
        ? (findEmptyGroup(char, candidateGroups, mapping.asset) || mapping.group)
        : (char.Appearance.find(a => a.Asset?.Group?.Name === mapping.group)
            ? (findEmptyGroup(char, [mapping.group, ...Asset.filter(a => a?.Group?.Name?.startsWith("Item") && a.Name === mapping.asset && a.Group.Name !== mapping.group).map(a => a.Group.Name)], mapping.asset) || mapping.group)
            : mapping.group);
      let targetAsset = AssetGet(char.AssetFamily, targetGroup, mapping.asset);

      // 颜色覆盖
      let colorOverride = null;
      if (color) {
        const hex = colorNameToHex(color);
        if (hex) {
          const cs = targetAsset?.ColorSchema;
          colorOverride = Array.isArray(cs) ? cs.map(() => hex) : [hex];
        }
      }
      const existingItem = char.Appearance.find(a => a.Asset?.Group?.Name === targetGroup);
      if (existingItem && colorOverride) directSetColor(char, targetGroup, colorOverride);
      else directSetItem(char, targetGroup, targetAsset, colorOverride);
      ChatRoomCharacterUpdate(char);
      console.log(`[MisakaChat] 已给 #${memberNumber} 添加 ${itemName} (group: ${targetGroup})`);
      return true;
    } catch(e) {
      console.error("[MisakaChat] 添加道具失败:", e.message);
      return false;
    }
  }

  function executeItemDel(memberNumber, itemName, part) {
    try {
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber); if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return false; }
      if (!char) return false;
      
      console.log(`[MisakaChat] executeItemDel #${memberNumber} item="${itemName}" part="${part||""}"`);
      
      // 使用 findItemByPart 支持部位限定
      let target = findItemByPart(char, itemName, part);
      
      // fallback: findItemAsset mapping
      if (!target) {
        const mapping = findItemAsset(itemName);
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
      if (!target) { console.log("[MisakaChat] 找不到道具:", itemName, part ? "(部位:" + part + ")" : ""); return false; }
      if (target?.Property?.LockedBy) {
        console.log(`[MisakaChat] 道具被锁: ${target.Property.LockedBy}`);
        return false;
      }
      const groupName = target.Asset.Group.Name;
      console.log(`[MisakaChat] 准备移除 #${memberNumber} group=${groupName} desc=${target.Asset.Description}`);
      directRemoveItem(char, groupName);
      ChatRoomCharacterUpdate(char);
      console.log(`[MisakaChat] 已移除 #${memberNumber} 的 ${itemName} (group: ${target.Asset.Group.Name})`);
      return true;
    } catch(e) {
      console.error("[MisakaChat] 移除道具失败:", e.message);
      return false;
    }
  }

  // 释放全部未锁道具
  function executeItemDelAll(memberNumber) {
    try {
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber); if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return false; }
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
      ChatRoomCharacterUpdate(char);
      console.log(`[MisakaChat] 释放 #${memberNumber} 全部道具: ${count}/${toRemove.length} 件`);
      return count > 0;
    } catch(e) {
      console.error("[MisakaChat] 释放全部失败:", e.message);
      return false;
    }
  }

  async function executeCommands(commands) {
    let moveOk = true, itemOk = true;
    const failures = [];

    const itemKey = (c) => (c && (c.type === "itemadd" || c.type === "itemdel"))
      ? `${c.memberNumber}:${c.item}:${c.part || ""}`
      : "";
    const replaceKeys = new Set();
    for (const c of commands) {
      if (c.type !== "itemadd") continue;
      const key = itemKey(c);
      if (commands.some(other => other.type === "itemdel" && itemKey(other) === key)) replaceKeys.add(key);
    }
    const filtered = [...commands].sort((a, b) => {
      const ka = itemKey(a), kb = itemKey(b);
      if (ka && ka === kb && replaceKeys.has(ka)) {
        if (a.type === "itemdel" && b.type === "itemadd") return -1;
        if (a.type === "itemadd" && b.type === "itemdel") return 1;
      }
      return 0;
    });

    const record = (cmd, result) => {
      const ok = (result && typeof result === "object" && "ok" in result) ? !!result.ok : !!result;
      if (!ok) failures.push({ cmd, reason: result?.reason || "failed" });
      return ok;
    };
    
    for (const cmd of filtered) {
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
      }
    }
    return { moveOk, itemOk, failures };
  }

  function displayNameByMemberNumber(memberNumber) {
    const char = (memberNumber === Player?.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
    return (char?.Nickname || char?.Name || ("#" + memberNumber));
  }

  // === 消息处理 ===
  function onChatRoomMessage(data) {
    if (!isCurrent() || !CONFIG.enabled) return;
    if (typeof Player === "undefined" || !Player) return;

    const content = data.Content || "";
    const senderNum = data.Sender;

    // 进出检测（在 validTypes 之前）
    if (data.Type === "Action" && ["ServerEnter","ServerDisconnect","ServerLeave"].includes(data.Content)) {
      let who = "";
      if (data.Dictionary?.length) {
        const ne = data.Dictionary.find(d => d.Tag === "SourceCharacter");
        if (ne) who = ne.Text || "";
      }
      // 有人进入时打招呼
      if (data.Content === "ServerEnter" && who) {
      }
      return; // 进出消息处理完毕，不再进入后续的上下文/计数逻辑
    }

    const validTypes = ["Chat","Talk","Emote","Whisper","Activity","Action"];
    if (!validTypes.includes(data.Type)) return;

    // === 垃圾消息过滤 ===
    const NOISE_PATTERNS = [
      /^TriggerShock[12]$/i,
      /^Beep$/i,
      /^OrgasmFailSurrender\d*$/i,
      /^Orgasm\d*$/i,
      /^ActionActivateSafewordRelease$/i,
      /^ChatSelf-ItemMouth-MoanGag(Giggle)?$/i,
    ];
    function isNoise(type, rawContent, senderName) {
      // GIMP 娃娃全部过滤（包括 Chat/Talk/Emote/Activity）
      if (senderName && senderName.startsWith("GIMP ")) return true;
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
      return;
    }

    const senderChar = ChatRoomCharacter.find(c => c.MemberNumber === senderNum);
    const senderName = (senderChar?.Nickname || senderChar?.Name) || ("#" + senderNum);
    // 判断是否为垃圾消息
    const noise = isNoise(data.Type, content, senderName);


    // 垃圾消息：不进上下文、不推动 messageCount
    if (noise) return;

    state.recentMessages.push({ senderName: senderName, content: readableContent, senderMemberNumber: senderNum, isSelf: false, time: now });
    if (state.recentMessages.length > CONFIG.maxContext) state.recentMessages.shift();
    state.lastNonSelfMsgTime = now;

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
    }, 45000);

    handleReply(senderNum, senderName, readableContent).finally(() => clearTimeout(replyTimeout));
  }

  // === BCE 查询（仅在被明确要求查档时触发） ===




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
                info.description = (b.Description||"").slice(0,200); info.descNote = /[^\u0020-\u007e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(info.description) ? "（含特殊装饰符号，非乱码）" : "";
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

  // 检测明确的档案查询请求（只在很明确的场景触发 BCE 查询）

function sanitizeReply(reply) {
    let cleaned = String(reply || "").replace(/^["""''''']+|["""''''']+$/g, "").trim();

    // thinking 模式下思考过程在 reasoning_content 里，content 是干净的回复
    // 这里只做格式处理：按行分割、兼容旧 | 格式、清理孤立 *
    let lines = cleaned.split(/\n+/).map(l => l.trim().replace(/^(御[搬坂]|Misaka|misaka)\s*[:：]\s*/i, "").trim()).filter(Boolean);
    // 最多取前两行（动作 + 说话）
    lines = lines.slice(0, 2);
    // 兼容旧 | 格式：如果单行包含 |，拆成多行
    lines = lines.flatMap(l => l.split(/\|/).map(s => s.trim()).filter(Boolean));
    lines = lines.slice(0, 2);
    // 清理每行：奇数 * 时去掉末尾孤立 *
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
    state.busy = true;
    window.__misakaGlobalBusy = true;
    state.lastReplyTime = Date.now();
    state.lastUserReplyTime[senderNum] = Date.now();

    try {
      await new Promise(r => setTimeout(r, CONFIG.replyDelayMs));

      // 构建上下文
      const contextMessages = state.recentMessages.slice(-CONFIG.maxContext).map(m => ({
        role: m.isSelf ? "assistant" : "user",
        content: `${m.senderName}: ${m.content}`
      }));

      // 构建系统 prompt（含精简房间名单）
      const systemPrompt = getSystemPrompt();

      let reply = await callLLM(systemPrompt, contextMessages);
      if (reply) {
        const firstPass = parseActionCommands(reply);
        const memCommands = firstPass.commands.filter(c => c.type === "memsearch");
        const bceCommands = firstPass.commands.filter(c => c.type === "bcequery");
        if (memCommands.length > 0 || bceCommands.length > 0) {
          let extraContext = "";
          if (memCommands.length > 0) {
            extraContext += await buildMemorySearchContext(memCommands);
          }
          if (bceCommands.length > 0) {
            for (const cmd of bceCommands) {
              const results = await queryProfile(cmd.target);
              if (results) {
                extraContext += "\n\n【BCE档案查询结果：" + cmd.target + "】\n";
                extraContext += results.map(r => {
                  let line = `${r.lastNick || r.name} (#${r.memberNumber}) - 档案查看: ${r.seen}`;
                  if (r.owner && r.owner !== "无") line += ` | 主人: ${r.owner}`;
                  if (r.lovers && r.lovers !== "无") line += ` | 恋人: ${r.lovers}`;
                  if (r.itemCount !== undefined) line += ` | ${r.itemCount}件束缚, ${r.lockCount}把锁`;
                  if (r.description) line += `\n描述: ${r.description}${r.descNote||""}`;
                  return line;
                }).join("\n");
                extraContext += "\n（档案时间是查看时间不是在线时间。直接用这些信息回答，不要说查不到。）";
              } else {
                extraContext += `\n\n【BCE档案查询结果：${cmd.target}】\n没有找到这个人的档案。\n`;
              }
            }
          }
          reply = await callLLM(systemPrompt + extraContext, contextMessages);
        }
      }
      if (!reply) { console.warn("[MisakaChat] LLM 返回空，未回复"); return; }

      // 解析操作指令
      const { commands, cleaned } = parseActionCommands(reply);
      const executableCommands = commands.filter(c => c.type !== "memsearch" && c.type !== "bcequery");
      let finalReply = sanitizeReply(cleaned);

      // 执行操作
      let commandResult = null;
      if (executableCommands.length > 0) {
        commandResult = await executeCommands(executableCommands);
        console.log("[MisakaChat] 操作执行:", executableCommands, commandResult);
        const missing = (commandResult.failures || []).find(f =>
          f.reason === "missing-item" || f.reason === "missing-part-item"
        );
        if (missing?.cmd) {
          const who = displayNameByMemberNumber(missing.cmd.memberNumber);
          finalReply = `${who}身上没有${missing.cmd.item}，没法改。`;
        }
      }

      // 如果只有指令没有文字回复，用默认回复
      if (!finalReply && executableCommands.length > 0) {
        const defaultReplies = ["好了~", "搞定了", "嗯，处理好了", "弄好了~", "已经调好了"];
        finalReply = defaultReplies[Math.floor(Math.random() * defaultReplies.length)];
      }
      if (!finalReply) return;

      // 存语义记忆（有意义的对话才存）
      if (finalReply.length > 3) {
        const memText = `${senderName}: ${content} → 御坂: ${finalReply}`;
        storeSemanticMemory(memText, { sender: senderName, memberNum: senderNum }).catch(() => {});
      }

      // 发送去重
      const sentKey = finalReply;
      const sentAt = Date.now();
      if (window.__misakaLastSentReply === sentKey && sentAt - (window.__misakaLastSentReplyTime || 0) < 5000) {
        console.warn("[MisakaChat] 跳过重复发送:", finalReply);
        return;
      }
      window.__misakaLastSentReply = sentKey;
      window.__misakaLastSentReplyTime = sentAt;

      if (typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom") {
        // 按换行分割动作和说话（兼容旧 | 格式）
        let parts = finalReply.split(/\n/).map(p => p.trim()).filter(Boolean);
        // 兼容旧 | 格式：单行含 | 时拆开
        if (parts.length === 1 && parts[0].includes("|")) {
          parts = parts[0].split(/\|/).map(p => p.trim()).filter(Boolean);
        }
        if (parts.length >= 2) {
          // 多段发送（动作/说话）
          let delay = 0;
          for (const p of parts) {
            if (!p) continue;
            setTimeout(() => { ElementValue("InputChat", p); ChatRoomSendChat(); }, delay);
            delay += 600;
          }
        } else {
          ElementValue("InputChat", parts[0] || finalReply);
          ChatRoomSendChat();
        }
        // 不再手动 push——BC 的 ChatRoomMessage hook 会自动处理 self message
        if (state.recentMessages.length > CONFIG.maxContext) state.recentMessages.shift();
      }

    } catch (e) {
      console.error("[MisakaChat] 回复失败:", e.message);
    } finally {
      state.busy = false;
      window.__misakaGlobalBusy = false;
      window.__misakaReplyInProgress = false;
    }
  }

  // === 命令系统 ===
  function handleCommand(msg) {
    if (!msg || !msg.startsWith("/misaka")) return false;
    const cmd = msg.slice("/misaka".length).trim();
    const parts = cmd.split(/\s+/);
    const sub = parts[0];
    if (sub === "on") { CONFIG.enabled = true; sendLocal("✅ 自动回复已开启"); }
    else if (sub === "off") { CONFIG.enabled = false; sendLocal("⏹ 自动回复已关闭"); }
    else if (sub === "key" && parts[1]) { localStorage.setItem(storageKey("apikey"), parts[1]); sendLocal("🔑 API key 已保存"); }
    else if (sub === "model" && parts[1]) { localStorage.setItem(storageKey("model"), parts[1]); CONFIG.model = parts[1]; sendLocal("🤖 模型已切换: " + parts[1]); }
    else if (sub === "status") {
      sendLocal(`状态: ${CONFIG.enabled?"开启":"关闭"} | 语义 ${state.semanticMemories.length} | 提炼 ${state.refinedMemories.length} | 认识 ${Object.keys(loadMemory().profiles||{}).length} 人`);
    } else if (sub === "forget") {
      localStorage.setItem(storageKey("memory"), "{}");
      state.semanticMemories = [];
      state.refinedMemories = [];
      IDB.clearAll();
      sendLocal("🧹 记忆已清空（含 IndexedDB 语义记忆）");
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
      if (!blob) { sendLocal("❌ 没有找到导出数据（先 export）"); }
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
      sendLocal("用法: /misaka on|off|key <key>|model <name>|status|forget|memory|persona <text>|export|import");
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

  // === 初始化 ===
  function init() {
    if (typeof Player === "undefined" || !Player) { setTimeout(init, 1000); return; }
    if (Player.MemberNumber !== 194331) { console.log("[MisakaChat] 非御坂账号，跳过"); return; }
    const savedModel = localStorage.getItem(storageKey("model")) || "";
    if (savedModel) CONFIG.model = savedModel;

    const existingMods = bcModSdk.getModsInfo();
    const existingMod = existingMods.find(m => m.name === "MisakaChat");
    let mod;
    if (existingMod) { console.log("[MisakaChat] mod 已注册"); mod = { hookFunction: () => {} }; }
    else {
      mod = bcModSdk.registerMod({ name: "MisakaChat", fullName: "Misaka Auto Chat v2", version: "2.0.0", repository: "https://github.com/Igallta/bc-gimp-sorter" });
    }

    window.__misakaOnMessage = onChatRoomMessage;

    // Rebind on every injection
    if (isCurrent()) {
      const orig = window.__misakaOrigChatRoomMessage || window.ChatRoomMessage;
      window.__misakaOrigChatRoomMessage = orig;
      window.__misakaWrapped = true;
      window.ChatRoomMessage = function(data) {
        try { if (data?.Content && window.__misakaOnMessage) window.__misakaOnMessage(data); }
        catch(e) { console.error("[MisakaChat] wrapper error:", e.message); }
        return orig.apply(this, arguments);
      };
      console.log("[MisakaChat] ChatRoomMessage wrapper 已设置/刷新 v2.0");
    }

    mod.hookFunction("ChatRoomSendChat", 10, (args, next) => {
      const msg = args[0];
      if (msg?.startsWith("/misaka")) { if (handleCommand(msg)) return; }
      return next(args);
    });

    console.log("[MisakaChat] ✅ 已初始化 v2.0.0");
    sendLocal("御坂自动回复 v2.0 已加载");
    startIdleTimer();
  }


  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(init, 2000);
  else window.addEventListener("load", () => setTimeout(init, 2000));
})();
