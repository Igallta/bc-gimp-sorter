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
    maxSummaries: 50,
    summaryInterval: 30,
    moveCooldownMs: 5000,  // 移动操作冷却
    compactionInterval: 50,  // 每 N 条消息生成一次 context compaction
    maxCompactionSummaries: 5,  // 保留最近 N 条 compaction 摘要
    idleTimeoutMs: 300000,  // 5 分钟无人说话触发 idle
    idleCheckMs: 60000,  // 每分钟检查一次 idle
    embeddingBase: "https://api.openai.com/v1/embeddings",
    embeddingModel: "text-embedding-3-large",
    embeddingDim: 3072,
    maxMemoryEntries: 2000, // IndexedDB 容量大，放宽到 2000 条
    memoryRefineInterval: 200,  // 每 N 条消息提炼一次长期记忆
    maxRefinedMemories: 10,  // 保留最近 N 条提炼记忆
    topKMemories: 3,  // 查询时返回最相似的 K 条记忆
  };

  let state = {
    recentMessages: [],
    lastReplyTime: 0,
    lastReplyTo: null,
    lastUserReplyTime: {},
    messageCount: 0,
    busy: false,
    roomJoinLog: [],
    lastMoveTime: 0,  // 移动操作冷却
    lastNonSelfMsgTime: 0,  // 上次非自己消息时间（idle 检测用）
    compactionPending: false,  // 正在生成 compaction 摘要
    greetEnabled: true,  // 自动欢迎开关，玩家可以语音开关
  };

  // 从 localStorage 加载 compaction 摘要
  // 从 localStorage 加载欢迎开关状态
  try {
    const savedGreet = localStorage.getItem("misaka_greet_enabled");
    if (savedGreet !== null) state.greetEnabled = savedGreet === "true";
  } catch(e) {}

  try {
    const savedCompaction = JSON.parse(localStorage.getItem("misaka_compaction") || "[]");
    if (Array.isArray(savedCompaction)) state.compactionSummaries = savedCompaction;
    else state.compactionSummaries = [];
  } catch(e) { state.compactionSummaries = []; }

  // === IndexedDB 封装（embedding 数据量大，localStorage 存不下） ===
  const IDB = (() => {
    const DB_NAME = "misaka_chat";
    const DB_VERSION = 1;
    const STORE_SEMANTIC = "semantic_mem";
    const STORE_REFINED = "refined_mem";
    let dbPromise = null;

    function openDB() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_SEMANTIC)) {
            db.createObjectStore(STORE_SEMANTIC, { keyPath: "id", autoIncrement: true });
          }
          if (!db.objectStoreNames.contains(STORE_REFINED)) {
            db.createObjectStore(STORE_REFINED, { keyPath: "id", autoIncrement: true });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }

    async function getAll(store) {
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(store, "readonly");
          const req = tx.objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      } catch (e) {
        console.warn("[MisakaChat] IDB getAll 失败:", e.message);
        return [];
      }
    }

    async function putMany(store, items) {
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(store, "readwrite");
          const os = tx.objectStore(store);
          for (const item of items) os.put(item);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {
        console.warn("[MisakaChat] IDB putMany 失败:", e.message);
        return false;
      }
    }

    async function clearStore(store) {
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(store, "readwrite");
          tx.objectStore(store).clear();
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {
        console.warn("[MisakaChat] IDB clear 失败:", e.message);
        return false;
      }
    }

    return {
      getSemantic: () => getAll(STORE_SEMANTIC),
      getRefined: () => getAll(STORE_REFINED),
      putSemantic: (items) => putMany(STORE_SEMANTIC, items),
      putRefined: (items) => putMany(STORE_REFINED, items),
      clearSemantic: () => clearStore(STORE_SEMANTIC),
      clearRefined: () => clearStore(STORE_REFINED),
      clearAll: () => Promise.all([clearStore(STORE_SEMANTIC), clearStore(STORE_REFINED)]),
      STORE_SEMANTIC,
      STORE_REFINED,
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

  // 兼容：如果 IDB 为空但 localStorage 有旧数据，迁移一次
  setTimeout(() => {
    if (state.semanticMemories.length === 0 && !state._idbMigrated) {
      try {
        const old = JSON.parse(localStorage.getItem("misaka_semantic_mem") || "[]");
        if (Array.isArray(old) && old.length > 0) {
          state.semanticMemories = old;
          IDB.putSemantic(old).then(() => {
            localStorage.removeItem("misaka_semantic_mem");
            console.log(`[MisakaChat] 从 localStorage 迁移 ${old.length} 条语义记忆到 IDB`);
          });
        }
      } catch(e) {}
    }
    if (state.refinedMemories.length === 0 && !state._idbMigrated) {
      try {
        const old = JSON.parse(localStorage.getItem("misaka_refined_mem") || "[]");
        if (Array.isArray(old) && old.length > 0) {
          state.refinedMemories = old;
          IDB.putRefined(old).then(() => {
            localStorage.removeItem("misaka_refined_mem");
            console.log(`[MisakaChat] 从 localStorage 迁移 ${old.length} 条提炼记忆到 IDB`);
          });
        }
      } catch(e) {}
    }
    state._idbMigrated = true;
  }, 2000);

  // === Embedding 维度迁移：512 → 3072 ===
  // 已有记忆的 embedding 是 512 维的，和新的 3072 维向量算 cosine 会维度不匹配
  // 用每条的 text 重新调 embedding API，替换旧向量
  async function rembedMemories() {
    const allSemantic = state.semanticMemories || [];
    const allRefined = state.refinedMemories || [];
    const needSemantic = allSemantic.filter(m => m.embedding && m.embedding.length !== 3072);
    const needRefined = allRefined.filter(m => m.embedding && m.embedding.length !== 3072);
    const total = needSemantic.length + needRefined.length;
    if (total === 0) {
      console.log("[MisakaChat] embedding 维度无需迁移");
      return;
    }
    console.log(`[MisakaChat] 开始重新 embedding ${total} 条记忆 (${needSemantic.length} 语义 + ${needRefined.length} 提炼)`);
    let done = 0;
    const BATCH = 5;
    // 分批重算 semantic
    for (let i = 0; i < needSemantic.length; i += BATCH) {
      const batch = needSemantic.slice(i, i + BATCH);
      await Promise.all(batch.map(async (m) => {
        const newEmb = await getEmbedding(m.text);
        if (newEmb && newEmb.length === 3072) {
          m.embedding = newEmb;
        }
        done++;
      }));
      // 每批间隔 500ms 避免限速
      await new Promise(r => setTimeout(r, 500));
      console.log(`[MisakaChat] re-embedding 进度: ${done}/${total}`);
    }
    // 分批重算 refined
    for (let i = 0; i < needRefined.length; i += BATCH) {
      const batch = needRefined.slice(i, i + BATCH);
      await Promise.all(batch.map(async (m) => {
        const newEmb = await getEmbedding(m.text);
        if (newEmb && newEmb.length === 3072) {
          m.embedding = newEmb;
        }
        done++;
      }));
      await new Promise(r => setTimeout(r, 500));
      console.log(`[MisakaChat] re-embedding 进度: ${done}/${total}`);
    }
    // 写回 IDB
    IDB.putSemantic(allSemantic);
    IDB.putRefined(allRefined);
    console.log(`[MisakaChat] re-embedding 完成，已写回 IDB`);
  }

  // 等 IDB 加载完成后自动触发迁移
  setTimeout(() => {
    if (state.idbReady) {
      rembedMemories();
    } else {
      // IDB 还没加载完，再等一下
      const waitInterval = setInterval(() => {
        if (state.idbReady) {
          clearInterval(waitInterval);
          rembedMemories();
        }
      }, 1000);
      // 最多等 30 秒
      setTimeout(() => clearInterval(waitInterval), 30000);
    }
  }, 5000);

  try {
    const savedLog = JSON.parse(localStorage.getItem("misaka_joinlog") || "[]");
    if (Array.isArray(savedLog) && savedLog.length > 0) state.roomJoinLog = savedLog;
  } catch(e) {}

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

  function maybeGenerateSummary() {
    if (state.messageCount % CONFIG.summaryInterval !== 0) return;
    const mem = loadMemory();
    if (!mem.summaries) mem.summaries = [];
    const recent = state.recentMessages.slice(-CONFIG.summaryInterval);
    const senders = [...new Set(recent.map(m => m.senderName))];
    mem.summaries.push(`${new Date().toISOString().slice(5, 16)}: ${senders.join("、")} 在房间里聊了天`);
    if (mem.summaries.length > CONFIG.maxSummaries) {
      const old = mem.summaries.slice(0, 2).join("；");
      mem.summaries = [old, ...mem.summaries.slice(2)];
    }
    saveMemory(mem);
  }

  // === Context Compaction ===
  // 每 compactionInterval 条消息，用 LLM 生成一段摘要，塞入 system prompt
  // 这样即使 recentMessages 超过 50 条被截断，御坂仍然记得之前发生了什么
  async function maybeCompactContext() {
    if (state.messageCount % CONFIG.compactionInterval !== 0 || state.compactionPending) return;
    if (state.messageCount === 0) return;
    state.compactionPending = true;
    try {
      // 取上一段 compactionInterval 条消息
      const segment = state.recentMessages.slice(-CONFIG.compactionInterval);
      if (segment.length < 5) { state.compactionPending = false; return; }
      
      const summaryPrompt = `用一句话概括以下 BC 聊天片段的要点（谁说了什么、发生了什么事、提到什么操作），不超过80字，用中文。
重要限制：
1. 用户让御坂改色/换色/调颜色，只能总结为"请求改色"，绝不要总结成"用户喜欢某颜色"。只有用户明确说"我喜欢/我偏好/我最喜欢"时才能写成偏好。
2. 御坂的回答可能包含编造/猜测的记忆（如"XX和我玩过YY"），只总结"御坂回答了XX"，不要把御坂的回答当作事实记录。
3. 区分"用户说的"和"御坂说的"，御坂说的内容不等于事实。

聊天片段：
${segment.map(m => `${m.senderName}: ${m.content}`).join("\n")}`;
      const summary = await callLLM("你是聊天摘要助手。只总结明确事实，禁止把操作请求推断成偏好。", [{role:"user", content: summaryPrompt}]);
      if (summary) {
        const time = new Date().toLocaleTimeString("zh-CN", {hour:"2-digit",minute:"2-digit"});
        state.compactionSummaries.push(`[${time}] ${summary.slice(0, 80)}`);
        if (state.compactionSummaries.length > CONFIG.maxCompactionSummaries) {
          state.compactionSummaries.shift();
        }
        try { localStorage.setItem("misaka_compaction", JSON.stringify(state.compactionSummaries)); } catch(e) {}
        console.log("[MisakaChat] Context compaction 完成:", summary.slice(0, 50));
      }
    } catch(e) {
      console.warn("[MisakaChat] Context compaction 失败:", e.message);
    } finally {
      state.compactionPending = false;
    }
  }

  // === Semantic Memory (Embedding-based) ===
  // 调用 OpenAI embedding API (text-embedding-3-large)
  function getEmbeddingKey() {
    // 从 localStorage 读 OpenAI API key
    return localStorage.getItem("misaka_openai_key") || "";
  }

  async function getEmbedding(text) {
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
        xhr.send(JSON.stringify({ model: CONFIG.embeddingModel, input: text.slice(0, 2000), dimensions: CONFIG.embeddingDim || 512 }));
      });
      if (resp && resp.data && resp.data[0] && resp.data[0].embedding) {
        return resp.data[0].embedding;
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

  // 存一条语义记忆（带 embedding）
  async function storeSemanticMemory(text, meta = {}) {
    if (!text || text.length < 5) return;
    if (state.semanticMemories.length >= CONFIG.maxMemoryEntries) {
      // 丢掉最老的 10 条
      state.semanticMemories.splice(0, 10);
    }
    const emb = await getEmbedding(text);
    if (!emb) return;  // embedding 失败就不存
    state.semanticMemories.push({
      text: text.slice(0, 500),
      embedding: emb,
      time: Date.now(),
      ...meta,
    });
    IDB.putSemantic(state.semanticMemories); // 异步写入 IndexedDB，不阻塞
  }

  // 语义搜索：用 query embedding 找最相似的 K 条记忆
  async function searchMemories(query, topK = CONFIG.topKMemories) {
    if (!query || state.semanticMemories.length === 0) return [];
    const qEmb = await getEmbedding(query);
    if (!qEmb) return [];
    const scored = state.semanticMemories.map(m => ({
      text: m.text,
      time: m.time,
      score: cosineSim(qEmb, m.embedding),
      ...m,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(s => s.score > 0.3);  // 相似度阈值
  }

  async function searchLongTermMemories(query, topK = CONFIG.topKMemories) {
    const results = [];
    const qEmb = await getEmbedding(query);

    // 语义搜索 semantic_mem
    try {
      if (qEmb && state.semanticMemories.length > 0) {
        const scored = state.semanticMemories.map(m => ({
          text: m.text, score: cosineSim(qEmb, m.embedding), source: "semantic", ...m,
        }));
        scored.sort((a, b) => b.score - a.score);
        for (const item of scored.slice(0, topK).filter(s => s.score > 0.3)) {
          if (item?.text) results.push({ text: item.text, score: item.score, source: "semantic" });
        }
      }
    } catch(e) {
      console.warn("[MisakaChat] 语义搜索失败:", e.message);
    }

    // 语义搜索 refined_mem（现在每条带 embedding）
    try {
      if (qEmb && Array.isArray(state.refinedMemories)) {
        const refinedScored = state.refinedMemories.map(m => {
          if (typeof m === "string") return { text: m, score: 0, source: "refined", _legacy: true };
          if (m.embedding && qEmb) return { text: m.text, score: cosineSim(qEmb, m.embedding), source: "refined" };
          return { text: m.text, score: 0, source: "refined", _legacy: true };
        });
        refinedScored.sort((a, b) => b.score - a.score);
        for (const item of refinedScored.slice(0, topK).filter(s => s.score > 0.3)) {
          results.push({ text: item.text, score: item.score, source: "refined" });
        }
      }
    } catch(e) {
      console.warn("[MisakaChat] refined 语义搜索失败:", e.message);
    }

    // fallback: 关键词匹配 refined_mem（兼容旧格式 string 条目）
    if (qEmb) {
      const q = String(query || "").toLowerCase();
      const terms = q.split(/[\s,，、。.!！?？;；:：]+/).filter(t => t.length >= 2);
      for (const entry of state.refinedMemories || []) {
        const text = typeof entry === "string" ? entry : entry?.text;
        if (!text) continue;
        const lower = text.toLowerCase();
        let kwScore = lower.includes(q) ? 3 : 0;
        for (const term of terms) if (lower.includes(term)) kwScore++;
        if (kwScore > 0) {
          // 避免重复（语义搜索已经命中的不再加）
          if (!results.some(r => r.text === text)) {
            results.push({ text, score: kwScore, source: "refined-keyword" });
          }
        }
      }
    }

    const seen = new Set();
    return results
      .filter(item => {
        const key = item.text;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
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
        blocks.push(`查询「${query}」:\n` + found.map(m => `- ${m.text}`).join("\n"));
      } else {
        blocks.push(`查询「${query}」: 没有找到明确记忆`);
      }
    }
    return "\n\n【长期记忆搜索结果】\n" + blocks.join("\n");
  }

  function preferenceMemoryGuard(content) {
    const text = String(content || "");
    if (!/(喜欢|偏好|最喜欢|讨厌)/.test(text)) return "";
    if (!/(记得|还记得|上次|以前|之前|什么颜色|哪种颜色|颜色)/.test(text)) return "";
    return `\n\n【本次是偏好记忆查询】\n只有在上下文/记忆中明确出现用户本人说过"我喜欢/我最喜欢/我偏好/我讨厌"时，才能回答偏好。\n用户曾要求你改色、换色、操作某种颜色，不等于用户喜欢这种颜色。\n如果没有明确偏好证据，必须回答"我没记过"或"不确定"，不要猜。`;
  }

  function isColorPreferenceQuery(content) {
    const text = String(content || "");
    if (!/(我|咲|自己).{0,8}(喜欢|偏好|最喜欢)/.test(text)) return false;
    return /(什么颜色|哪种颜色|颜色是什么|喜欢什么|偏好什么|记得.*颜色|以前.*颜色|之前.*颜色)/.test(text);
  }

  function extractExplicitColorPreference(text, speakerName) {
    const raw = String(text || "");
    const beforeReply = raw.split(/→|=>/)[0];
    const speakerPrefix = speakerName ? `${speakerName}:` : "";
    let content = beforeReply;
    if (speakerPrefix && content.includes(speakerPrefix)) {
      content = content.slice(content.lastIndexOf(speakerPrefix) + speakerPrefix.length);
    }
    if (/(什么|哪种|哪个|吗|么|？|\?)/.test(content)) return "";
    if (/(改|换|调|弄|染|变成|设置|窝|窝窝|口球|项圈|道具|衣服|内衬|毛毯|带子)/.test(content)) return "";
    const match = content.match(/(?:我|咲)(?:真的|其实|比较|最)?\s*(?:最喜欢|喜欢|偏好|更喜欢)\s*(?:的颜色)?(?:是|为|:|：)?\s*(#[0-9a-fA-F]{6}|[一-龥A-Za-z0-9#]{1,12}色)/);
    if (!match) return "";
    const color = match[1].trim();
    if (/(什么|哪|这个|那个|这种|那种)/.test(color)) return "";
    return color;
  }

  function findExplicitColorPreference(senderNum, senderName) {
    const candidates = [];
    const recent = (state.recentMessages || []).filter(m =>
      !m.isSelf && (m.senderMemberNumber === senderNum || m.senderName === senderName)
    );
    for (const m of recent) candidates.push(m.content);
    for (const m of (state.semanticMemories || [])) {
      if (m.memberNum === senderNum || m.sender === senderName) candidates.push(m.text);
    }
    const mem = loadMemory();
    const profile = mem.profiles && mem.profiles[String(senderNum)];
    if (profile?.notes) candidates.push(`${senderName}: ${profile.notes}`);

    for (let i = candidates.length - 1; i >= 0; i--) {
      const color = extractExplicitColorPreference(candidates[i], senderName);
      if (color) return color;
    }
    return "";
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
      const compactions = (state.compactionSummaries || []).join("\n");
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

对话摘要:
${compactions}

记忆片段:
${recentSemantic}`;
      const refined = await callLLM("你是记忆提炼助手。只提炼有明确证据的长期信息，禁止把操作请求推断成偏好。", [{role:"user", content: prompt}]);
      if (refined) {
        const time = new Date().toLocaleDateString("zh-CN", {month:"2-digit",day:"2-digit"});
        const refinedText = `[${time}] ${refined.slice(0, 100)}`;
        // 给 refined memory 算 embedding，让语义搜索能命中
        let refinedEmb = null;
        try { refinedEmb = await getEmbedding(refinedText); } catch(e) {}
        state.refinedMemories.push({ text: refinedText, embedding: refinedEmb });
        if (state.refinedMemories.length > CONFIG.maxRefinedMemories) {
          state.refinedMemories.shift();
        }
        IDB.putRefined(state.refinedMemories); // 异步写入 IndexedDB
        console.log("[MisakaChat] 长期记忆提炼完成:", refined.slice(0, 50));
      }
    } catch(e) {
      console.warn("[MisakaChat] 记忆提炼失败:", e.message);
    }
  }

  // === Idle / Heartbeat ===
  // 常客打招呼池（更亲昵、带名字）
  const GREET_REGULAR = [
    "{name}，又来啦~",
    "哦？{name}来了~",
    "{name}，今天挺早的嘛。",
    "欢迎回来，{name}~",
    "*抬头看到{name}*|你来了呀~",
    "哟，{name}。",
    "来了来了，{name}~",
  ];
  // 陌生人打招呼池（友好但不带名字）
  const GREET_STRANGER = [
    "欢迎~",
    "你来了呀~",
    "*抬头看了一眼*|来了啊~",
    "欢迎来到 Gimp Dolls~",
    "哟，新面孔~",
    "嗯？新人来了~",
  ];
  // GIMP 娃娃打招呼池（对被束缚的人偶，语气更玩味）
  const GREET_GIMP = [
    "又多了个娃娃~",
    "*打量了一下新来的娃娃*",
    "嗯，新娃娃到了。",
    "*歪头看着新来的娃娃*",
    "欢迎来到娃娃架~",
  ];
  // idle 闲聊池（带上下文）
  const IDLE_LINES = [
    "房间里好安静啊...",
    "..没有人想聊聊天吗？",
    "*整理了一下袖口*",
    "安静下来了呢。",
    "*百无聊赖地翻看记录本*",
    "嗯...在等什么人吗？",
    "*小声哼着歌*",
    "*靠在墙边发呆*",
    "好闲啊...来个人让我搬搬娃娃也好嘛~",
    "咲不在吗...算了。",
    "*打了个哈欠*",
    "今天娃娃们都挺乖的嘛。",
    "*数了数房间里的娃娃*|嗯...还是这些。",
    "有人来玩吗？好无聊~",
    "*歪头看着门口*",
  ];
  let idleTimer = null;

  async function generateIdleLine() {
    try {
      let roster = "";
      if (typeof MisakaPersona !== "undefined" && typeof ChatRoomCharacter !== "undefined" && Array.isArray(ChatRoomCharacter) && typeof Player !== "undefined") {
        roster = MisakaPersona.buildCompactRoster(ChatRoomCharacter, Player.MemberNumber)
          .split("\n")
          .slice(0, 12)
          .join("\n");
      }
      const recent = state.recentMessages.slice(-3).map(m => `${m.senderName}: ${m.content}`).join("\n");
      const systemPrompt = `你是御坂，BC Gimp Dolls 房间管理员。现在房间安静了，请根据当前房间状态自然说一句闲聊或做一个小动作。
要求：中文为主，不超过40字；不要提AI、脚本、系统；不要输出操作指令；只用纯说话、*动作*、或 *动作*|说话。`;
      const userPrompt = `当前房间名单:
${roster || "暂无名单"}

最近消息:
${recent || "暂无"}

生成一句自然的 idle 闲聊。`;
      const reply = await callLLM(systemPrompt, [{ role: "user", content: userPrompt }], {
        model: CONFIG.fallbackModel,
        fallbackModel: CONFIG.fallbackModel,
        maxTokens: 120,
        temperature: 0.9,
      });
      return sanitizeReply(reply || "");
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
          const line = generated || IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)];
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
  function maybeGreetNewcomer(name) {
    if (!isCurrent() || !CONFIG.enabled || state.busy) return;
    if (!state.greetEnabled) return;  // 自动欢迎已关闭
    if (!name) return;
    // 不跟自己打招呼
    if (typeof Player !== "undefined" && name === (Player.Nickname || Player.Name)) return;
    const now = Date.now();
    // 30 秒内不给同一个人重复打招呼
    if (now - (state._lastGreetTime || 0) < 30000) return;
    state._lastGreetTime = now;
    
    const delay = 2000 + Math.random() * 3000;
    setTimeout(() => {
      if (!isCurrent() || !CONFIG.enabled || state.busy) return;
      if (!state.greetEnabled) return;
      if (typeof CurrentScreen === "undefined" || CurrentScreen !== "ChatRoom") return;
      // 100% 打招呼
      // if (Math.random() > 0.85) return;
      // GIMP 娃娃用专用池
      const isGimp = name.startsWith("GIMP ");
      const profiles = JSON.parse(localStorage.getItem('misaka_memory') || '{}');
      const isRegular = !isGimp && (profiles[name] || Object.values(profiles).some(p => p.name === name));
      const pool = isGimp ? GREET_GIMP : (isRegular ? GREET_REGULAR : GREET_STRANGER);
      let line = pool[Math.floor(Math.random() * pool.length)];
      // 常客池带名字替换
      if (isRegular) line = line.replace(/\{name\}/g, name);
      try {
        ElementValue("InputChat", line);
        ChatRoomSendChat();
        state.recentMessages.push({ senderName: "御搬", content: line, isSelf: true, time: Date.now() });
        if (state.recentMessages.length > 50) state.recentMessages.shift();
      } catch(e) { console.warn("[MisakaChat] greeting 发送失败:", e.message); }
    }, delay);
  }

  // 从 DeepSeek 响应提取回复（处理 thinking 模式 content 为空）
  function extractReply(msg) {
    if (!msg) return null;
    let content = (msg.content || "").trim();
    if (content) return content;
    let reasoning = (msg.reasoning_content || "").trim();
    if (!reasoning) return null;
    const lines = reasoning.split("\n").filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.length > 2 && line.length < 100) return line;
    }
    return reasoning.slice(-80) || null;
  }

  // === API 调用 ===
  async function callLLM(systemPrompt, contextMessages, options = {}) {
    const apiKey = localStorage.getItem(storageKey("apikey")) || "";
    if (!apiKey) { console.warn("[MisakaChat] 未设置 API key"); return null; }
    const messages = [{ role: "system", content: systemPrompt }, ...contextMessages];
    const primaryModel = options.model || CONFIG.model;
    const fallbackModel = options.fallbackModel || CONFIG.fallbackModel;
    const maxTokens = options.maxTokens || CONFIG.maxTokens;
    const temperature = options.temperature ?? CONFIG.temperature;

    return new Promise((resolve) => {
      const doRequest = (url, model, isFallback) => {
        const reqBody = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature });
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

  // === 人设 + 房间名单 ===
  function getSystemPrompt() {
    const mem = loadMemory();
    if (typeof MisakaPersona === "undefined") {
      return `你是御坂 (Misaka)，Bondage Club 中 Gimp Dolls 房间的管理员。安静、简短、偶尔傲娇。中文为主，回复不超过50字。不提及AI或现实信息。`;
    }

    // 构建精简房间名单
    let roster = "";
    if (typeof ChatRoomCharacter !== "undefined" && Array.isArray(ChatRoomCharacter) && typeof Player !== "undefined") {
      roster = MisakaPersona.buildCompactRoster(ChatRoomCharacter, Player.MemberNumber);
    }
    mem.roster = roster;

    // 进出记录
    let joinInfo = "";
    if (state.roomJoinLog.length > 0) {
      const lastJoin = [...state.roomJoinLog].reverse().find(e => e.action === "join");
      if (lastJoin) {
        const _t = new Date(lastJoin.time).toLocaleString("zh-CN", {hour:"2-digit",minute:"2-digit"});
        joinInfo = "最后进入: " + lastJoin.name + " (" + _t + ")";
      }
      const recent = state.roomJoinLog.slice(-5);
      joinInfo += "\n最近: " + recent.map(e => `${e.name}${e.action === "join" ? "进入" : "离开"}`).join(" → ");
    }
    mem.joinInfo = joinInfo || "暂无记录";

    // Context compaction 摘要
    if (state.compactionSummaries && state.compactionSummaries.length > 0) {
      mem.compaction = state.compactionSummaries.slice(-CONFIG.maxCompactionSummaries);
    }
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
      .replace(/\[SNAPSHOT:save:(\d+)\]/gi, (m, mn) => {
        commands.push({ type: "snapshotSave", memberNumber: parseInt(mn) });
        return "";
      })
      .replace(/\[SNAPSHOT:restore:(\d+)\]/gi, (m, mn) => {
        commands.push({ type: "snapshotRestore", memberNumber: parseInt(mn) });
        return "";
      })
      .replace(/\[COPY:(\d+):to:(\d+)\]/gi, (m, src, dst) => {
        commands.push({ type: "copyBonds", srcNumber: parseInt(src), dstNumber: parseInt(dst) });
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
      // 处理被截断的指令 — [ITEMDEL:123 后面没有 ]
      .replace(/\[ITEMADD:(\d+)$/gi, (m, mn) => {
        console.log("[MisakaChat] 检测到截断的 ITEMADD 指令: " + m);
        return "";
      })
      .replace(/\[ITEMSET:(\d+)$/gi, (m, mn) => {
        console.log("[MisakaChat] 检测到截断的 ITEMSET 指令: " + m);
        return "";
      })
      .replace(/\[ITEMDEL:(\d+)$/gi, (m, mn) => {
        // 截断的 ITEMDEL — 当作"释放全部"处理
        commands.push({ type: "itemdelall", memberNumber: parseInt(mn) });
        console.log("[MisakaChat] 截断的 ITEMDEL 当作释放全部: #" + mn);
        return "";
      })
      .replace(/\[MOVE:(\d+)$/gi, (m, mn) => {
        console.log("[MisakaChat] 检测到截断的 MOVE 指令: " + m);
        return "";
      })
      .replace(/\[COPY:(\d+)$/gi, (m, mn) => {
        console.log("[MisakaChat] 检测到截断的 COPY 指令: " + m);
        return "";
      });
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

  // 同义词映射 — 用户/LLM 常用泛称 → BC 实际道具名
  const SYNONYMS = {
    "绳子": "麻绳", "绳索": "麻绳", "绳缚": "麻绳",
    "口塞": "口球", "堵嘴": "麻绳堵嘴",
    "眼罩": "皮制眼罩", "蒙眼": "皮制眼罩",
    "手铐": "金属手铐", "铐": "金属手铐",
    "贞操": "高科技贞操带", "锁": "金属贞操带",
    "单手套": "皮制单手套", "臂袋": "皮制单手套",
    "高跟": "芭蕾高跟鞋", "芭蕾": "芭蕾高跟鞋",
  };

  // 部位名 → BC Item group 列表（按优先级）
  const BODY_PART_GROUPS = {
    "手臂": ["ItemArms"],
    "手": ["ItemHands"],
    "腿": ["ItemLegs"],
    "脚": ["ItemFeet"],
    "嘴": ["ItemMouth", "ItemMouth2", "ItemMouth3"],
    "口": ["ItemMouth", "ItemMouth2", "ItemMouth3"],
    "头": ["ItemHead", "ItemHood"],
    "脖子": ["ItemNeck", "ItemNeckRestraints"],
    "颈": ["ItemNeck", "ItemNeckRestraints"],
    "身体": ["ItemTorso", "ItemTorso2"],
    "躯": ["ItemTorso", "ItemTorso2"],
    "腰": ["ItemPelvis"],
    "胸": ["ItemBreast", "ItemNipples", "ItemNipplesPiercings"],
    "眼": ["ItemHead"],
    "耳": ["ItemEars"],
    "下体": ["ItemVulva", "ItemVulvaPiercings", "ItemButt", "ItemClit"],
    "道具": ["ItemDevices"],
  };

  function findItemByPart(char, itemName, part) {
    if (!char) return null;
    const searchName = SYNONYMS[itemName] || itemName;
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

  // 动态道具查找 — 从 BC Asset 数组里按中文名搜索
  // 优先束缚类 group，避免误配到 ItemHandheld
  const RESTRAINT_GROUPS = [
    "ItemMouth","ItemMouth2","ItemMouth3","ItemHead","ItemHood","ItemEars",
    "ItemNeck","ItemNeckAccessories","ItemArms","ItemHands","ItemFeet",
    "ItemLegs","ItemBoots","ItemTorso","ItemTorso2","ItemPelvis",
    "ItemBreast","ItemNipples","ItemNipplesPiercings","ItemVulva",
    "ItemVulvaPiercings","ItemButt","ItemDevices","ItemClit"
  ];
  const LOW_PRIORITY_GROUPS = ["ItemHandheld","ItemScript","ItemAddon","ItemMisc","ItemNeckRestraints"];

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

    const exact = Asset.find(a => a?.Group?.Name?.startsWith("Item") && a.Name === rawName);
    if (exact) return { group: exact.Group.Name, asset: exact.Name };

    // 同义词转换
    itemName = SYNONYMS[rawName] || rawName;
    // 模糊同义词：包含"绳"字的都映射到"麻绳"
    if (itemName.includes("绳") && !itemName.includes("颈") && !itemName.includes("纯")) itemName = "麻绳";
    if (itemName.includes("口塞") && !itemName.includes("模块")) itemName = "口球";
    
    // 按优先级分组查找
    const priorityOrder = [
      ...RESTRAINT_GROUPS,
      null, // 其他 Item group
      ...LOW_PRIORITY_GROUPS
    ];
    
    for (const priorityGroup of priorityOrder) {
      // 1. 精确匹配
      for (const a of Asset) {
        const gName = a?.Group?.Name || "";
        if (!gName.startsWith("Item")) continue;
        const isMatch = priorityGroup === null 
          ? !RESTRAINT_GROUPS.includes(gName) && !LOW_PRIORITY_GROUPS.includes(gName)
          : gName === priorityGroup;
        if (isMatch && a.Name === itemName) {
          return { group: gName, asset: a.Name };
        }
        if (isMatch && (a.Description === itemName || assetCnName(a) === itemName)) {
          return { group: gName, asset: a.Name };
        }
      }
    }
    
    for (const priorityGroup of priorityOrder) {
      // 2. 包含匹配
      for (const a of Asset) {
        const gName = a?.Group?.Name || "";
        if (!gName.startsWith("Item")) continue;
        const isMatch = priorityGroup === null 
          ? !RESTRAINT_GROUPS.includes(gName) && !LOW_PRIORITY_GROUPS.includes(gName)
          : gName === priorityGroup;
        const cn = assetCnName(a);
        if (isMatch && ((a.Description && a.Description.includes(itemName)) || (cn && cn.includes(itemName)))) {
          return { group: gName, asset: a.Name };
        }
      }
    }
    
    for (const priorityGroup of priorityOrder) {
      // 3. 反向包含
      for (const a of Asset) {
        const gName = a?.Group?.Name || "";
        if (!gName.startsWith("Item")) continue;
        const isMatch = priorityGroup === null 
          ? !RESTRAINT_GROUPS.includes(gName) && !LOW_PRIORITY_GROUPS.includes(gName)
          : gName === priorityGroup;
        const cn = assetCnName(a);
        if (isMatch && ((a.Description && itemName.includes(a.Description)) || (cn && itemName.includes(cn)))) {
          return { group: gName, asset: a.Name };
        }
      }
    }
    return null;
  }

  // 拘束快照系统 — 存储玩家当前道具状态，用于"绑回去"
  function saveSnapshot(memberNumber) {
    const char = ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
    if (!char) return null;
    const items = (char.Appearance || [])
      .filter(a => a?.Asset?.Group?.Name?.startsWith("Item"))
      .map(a => {
        const prop = a.Property ? JSON.parse(JSON.stringify(a.Property)) : {};
        delete prop.LockedBy;
        delete prop.LockMemberNumber;
        return {
          group: a.Asset.Group.Name,
          asset: a.Asset.Name,
          desc: a.Asset.Description || a.Asset.Name,
          color: Array.isArray(a.Color) ? [...a.Color] : (a.Color || ["Default"]),
          property: prop
        };
      });
    const snapshot = { memberNumber, name: char.Nickname || char.Name, items, time: Date.now() };
    try {
      localStorage.setItem("misaka_snapshot_" + memberNumber, JSON.stringify(snapshot));
    } catch(e) {}
    return snapshot;
  }

  function loadSnapshot(memberNumber) {
    try {
      return JSON.parse(localStorage.getItem("misaka_snapshot_" + memberNumber) || "null");
    } catch(e) { return null; }
  }

  // 按 snapshot 恢复玩家道具
  async function executeRestoreSnapshot(memberNumber) {
    const snapshot = loadSnapshot(memberNumber);
    if (!snapshot) return false;
    const char = ChatRoomCharacter.find(c => c.MemberNumber === memberNumber);
    if (!char) return false;
    // 先清除当前所有未锁的 Item
    for (const a of [...(char.Appearance || [])]) {
      if (a?.Asset?.Group?.Name?.startsWith("Item") && !a.Property?.LockedBy) {
        try {
          directRemoveItem(char, a.Asset.Group.Name);
        } catch(e) {}
      }
    }
    // 逐个恢复，每件道具后都同步
    let count = 0;
    for (const item of snapshot.items) {
      try {
        const asset = AssetGet(char.AssetFamily, item.group, item.asset);
        if (asset) {
          directSetItem(char, item.group, asset, item.color, item.property);
          count++;
          await new Promise(r => setTimeout(r, 150));
        }
      } catch(e) { console.warn("[MisakaChat] 恢复道具失败:", item.desc, e.message); }
    }
    ChatRoomCharacterUpdate(char);
    console.log(`[MisakaChat] 恢复快照 #${memberNumber}: ${count}/${snapshot.items.length} 件道具`);
    return count > 0;
  }

  // 复制 src 玩家的道具到 dst 玩家
  async function executeCopyBonds(srcNumber, dstNumber) {
    const srcChar = ChatRoomCharacter.find(c => c.MemberNumber === srcNumber);
    const dstChar = ChatRoomCharacter.find(c => c.MemberNumber === dstNumber);
    if (!srcChar || !dstChar) return false;
    // 保存 src 的快照
    const snapshot = saveSnapshot(srcNumber);
    if (!snapshot) return false;
    // 用快照恢复到 dst
    // 先清除 dst 所有未锁的 Item
    for (const a of [...(dstChar.Appearance || [])]) {
      if (a?.Asset?.Group?.Name?.startsWith("Item") && !a.Property?.LockedBy) {
        try { directRemoveItem(dstChar, a.Asset.Group.Name); } catch(e) {}
      }
    }
    // 逐个添加 src 的道具到 dst，每件后同步
    let count = 0;
    let failed = [];
    for (const item of snapshot.items) {
      try {
        const asset = AssetGet(dstChar.AssetFamily, item.group, item.asset);
        if (asset) {
          directSetItem(dstChar, item.group, asset, item.color, item.property);
          count++;
          await new Promise(r => setTimeout(r, 150));
        } else {
          failed.push(item.desc || item.asset);
        }
      } catch(e) { 
        failed.push(item.desc || item.asset);
        console.warn("[MisakaChat] 复制道具失败:", item.desc, e.message); 
      }
    }
    ChatRoomCharacterUpdate(dstChar);
    console.log(`[MisakaChat] 复制束缚 #${srcNumber} → #${dstNumber}: ${count}/${snapshot.items.length} 件, 失败: ${failed.join(",")}`);
    return { ok: count > 0, count, total: snapshot.items.length, failed };
  }

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
    const expectedLen = item.Color?.length || item.Asset?.ColorableLayerCount || 1;
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
    if (layers.length === 0) return undefined;
    const raw = String(layerName).trim();
    // 1. 精确匹配英文 layer 名（清单里展示的名字）
    let found = layers.find(l => l.name === raw);
    if (found) return found.index;
    // fallback: 英文大小写不敏感/包含匹配放最后，兼容少量旧输出
    const lower = raw.toLowerCase();
    found = layers.find(l => l.name && l.name.toLowerCase() === lower);
    if (found) return found.index;
    found = layers.find(l => l.name && l.name.length >= 2 && lower.includes(l.name.toLowerCase()));
    if (found) return found.index;
    return undefined;
  }

  function directRemoveItem(char, groupName) {
    if (!char) return false;
    const idx = char.Appearance.findIndex(a => a.Asset?.Group?.Name === groupName);
    if (idx < 0) return false;
    char.Appearance.splice(idx, 1);
    if (typeof CharacterRefresh === "function") CharacterRefresh(char);
    return true;
  }

  // 颜色名 → hex 映射
  const COLOR_NAME_TO_HEX = {
    "红色": "#FF0000", "红": "#FF0000",
    "蓝色": "#0000FF", "蓝": "#0000FF",
    "绿色": "#00FF00", "绿": "#00FF00",
    "黄色": "#FFFF00", "黄": "#FFFF00",
    "紫色": "#8000FF", "紫": "#8000FF",
    "粉色": "#FFC0CB", "粉": "#FFC0CB", "粉红": "#FFC0CB",
    "橙色": "#FFA500", "橙": "#FFA500", "橙红": "#FF4500",
    "青色": "#00FFFF", "青": "#00FFFF",
    "品红": "#FF00FF",
    "黑色": "#000000", "黑": "#000000",
    "白色": "#FFFFFF", "白": "#FFFFFF",
    "灰色": "#808080", "灰": "#808080",
    "浅灰": "#C0C0C0", "深灰": "#404040",
    "棕色": "#8B4513", "棕": "#8B4513",
    "金色": "#FFD700", "金": "#FFD700",
    "银色": "#C0C0C0", "银": "#C0C0C0",
    "米色": "#F5F5DC",
    "淡金": "#F0E68C",
    "深蓝灰": "#2F4F4F",
    "灰蓝": "#778899",
  };

  function colorNameToHex(name) {
    if (!name) return null;
    const n = name.trim();
    const hexMatch = n.match(/#[0-9A-Fa-f]{6}/);
    if (hexMatch) return hexMatch[0].toUpperCase();
    // "默认"/"Default" → 返回特殊标记，由 directSetColor 处理
    if (/默认|Default|原色|恢复默认|复原/.test(n)) return "Default";
    return COLOR_NAME_TO_HEX[n] || null;
  }

  // 道具属性映射 — 中文属性名 → 处理方式
  // vibrating archetype 用 VIB_INTENSITY_CN 映射
  // typed archetype 用数字索引
  // modular archetype 用模块 key + 数字索引
  const PROPERTY_MAP = {
    "强度": { type: "vibrator" },
    "震动": { type: "vibrator" },
    "模式": { type: "vibrator" },
    "开关": { type: "direct", key: "SetState", values: { "开": true, "关": false, "开启": true, "关闭": false } },
    "绑法": { type: "typed" },
    "类型": { type: "typed" },
    "样式": { type: "typed" },
    "透明度": { type: "direct", key: "Opacity", values: null },
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

  // 中文振动器档位 → VIBRATOR_OPTIONS 索引
  const VIB_INTENSITY_CN = {
    "关": 0, "关闭": 0, "低": 1, "弱": 1, "中": 2, "高": 3, "强": 3, "最大": 4, "极限": 4,
    "随机": 5, "递增": 6, "挑逗": 7, "拒绝": 8, "边缘": 9
  };

  // 中文绑法/样式名 → BC 英文选项名映射
  // 用 TypedItemSetOptionByName 调用，走 BC 正规 API
  const STYLE_NAME_CN = {
    // 麻绳/尼龙绳 ItemArms — BC 中文圈常用绑法名
    "手腕绑": "WristTie", "基础": "WristTie", "普通": "WristTie", "手腕": "WristTie",
    "后手缚": "BoxTie", "箱形绑": "BoxTie", "空手绑": "BoxTie", "龟甲缚": "BoxTie",
    "交叉后手缚": "CrossedBoxtie", "交叉箱形": "CrossedBoxtie", "交叉绑": "CrossedBoxtie",
    "绳铐": "RopeCuffs", "手腕绳铐": "RopeCuffs",
    "并肘绑": "WristElbowTie", "手腕肘绑": "WristElbowTie", "手肘绑": "WristElbowTie",
    "简单驷马缚": "SimpleHogtie", "简单猪绑": "SimpleHogtie", "猪绑": "SimpleHogtie",
    "紧后手缚": "TightBoxtie", "紧箱形": "TightBoxtie", "紧绑": "TightBoxtie",
    "驾驭绑": "WristElbowHarnessTie", "手腕肘驾驭绑": "WristElbowHarnessTie",
    "跪姿驷马缚": "KneelingHogtie", "跪姿猪绑": "KneelingHogtie",
    "驷马缚": "Hogtied", "猪绑缚": "Hogtied", "全猪绑": "Hogtied", "驷马": "Hogtied",
    "四肢着地": "AllFours", "趴绑": "AllFours",
    "床展鹰": "BedSpreadEagle", "展鹰": "BedSpreadEagle", "大字绑": "BedSpreadEagle",
    "悬吊跪姿驷马": "SuspensionKneelingHogtie", "悬吊跪姿猪绑": "SuspensionKneelingHogtie",
    "悬吊驷马缚": "SuspensionHogtied", "悬吊猪绑": "SuspensionHogtied", "悬吊驷马": "SuspensionHogtied",
    "悬吊四肢着地": "SuspensionAllFours",
    "倒吊驷马缚": "InvertedSuspensionHogtied", "倒吊猪绑": "InvertedSuspensionHogtied", "倒吊": "InvertedSuspensionHogtied",
    "倒吊四肢着地": "InvertedSuspensionAllFours",
    // 通用铐类
    "链条": "Chain", "铐": "Cuffs", "环": "Rings", "桶": "Buckets", "锁": "Lock",
    "无": "None", "关闭": "None", "闭合": "Closed", "链接": "Chained",
    // 口塞类
    "普通": "Normal", "紧": "Tight", "亮": "Shiny",
    "小": "Small", "交叉": "Crossed", "全": "Full", "双层": "Double", "覆盖": "Cover",
    "打开": "Open", "塞入": "Plug", "空": "Empty",
    // 绳类 ItemLegs
    "膝盖": "Knees", "大腿": "Thighs", "青蛙绑": "Frogtie", "交叉腿": "Crossed",
    // 绳类 ItemFeet
    "脚踝": "Ankles", "膝盖脚踝": "AnklesKnees",
    // 道具设备
    "关": "Opaque", "开": "Shadow", // 折叠屏风
    //贞操带
    "后开": "OpenBack", "后闭": "ClosedBack",
    // 束腰
    "吊带": "Garter", "无吊带": "Garterless",
    // 乳胶衣/紧身衣
    "乳胶衣": "Latex", "透视": "UnZip",
  };

  function isVibratorAsset(asset) {
    return /Vibrating|Vibrator|Vibe|Egg|ButtPlug|CatButtPlug|ClitPiercing/i.test(asset?.Name || "");
  }

  function readAllowedTypedProperties(asset) {
    const values = [];
    const add = (entry) => {
      if (!entry) return;
      if (typeof entry === "string") values.push(entry);
      else if (entry.Name) values.push(entry.Name);
      else if (entry.Property) values.push(entry.Property);
      else if (entry.Option) values.push(entry.Option);
      else if (entry.Type) values.push(entry.Type);
    };
    if (Array.isArray(asset?.AllowTypedProperties)) {
      for (const entry of asset.AllowTypedProperties) add(entry);
    }
    return [...new Set(values)].filter(Boolean);
  }

  // 在 setExtendedItemProperty 的 typed 分支里用动态 BC 选项，中文表只作 fallback
  // 返回 BC 选项名（英文），而非索引
  function findTypedOptionName(item, valueName) {
    // 先尝试直接作为英文选项名，运行时用 TypedItemDataLookup 验证
    try {
      const key = item.Asset.Group.Name + item.Asset.Name;
      const data = TypedItemDataLookup[key];
      if (data?.options) {
        const opt = data.options.find(o => o.Name === valueName || o.Name?.toLowerCase() === valueName.toLowerCase());
        if (opt) return opt.Name;
      }
    } catch(e) {}

    const valueLower = String(valueName || "").toLowerCase();
    const dynamicNames = readAllowedTypedProperties(item.Asset);
    const dynamic = dynamicNames.find(n => n === valueName || String(n).toLowerCase() === valueLower);
    if (dynamic) return dynamic;

    // 旧中文映射表保留作 fallback
    if (STYLE_NAME_CN[valueName]) return STYLE_NAME_CN[valueName];
    return null;
  }

  function findDynamicPropertyKey(asset, propName) {
    const keys = readAllowedTypedProperties(asset);
    const raw = String(propName || "");
    const lower = raw.toLowerCase();
    return keys.find(k => k === raw || String(k).toLowerCase() === lower) || null;
  }

  function normalizeDirectPropertyValue(valueName, valueMap) {
    if (valueMap && Object.prototype.hasOwnProperty.call(valueMap, valueName)) return valueMap[valueName];
    if (/^(true|on|open|yes|1|开|开启|打开)$/i.test(valueName)) return true;
    if (/^(false|off|close|closed|no|0|关|关闭)$/i.test(valueName)) return false;
    const num = Number(valueName);
    if (!Number.isNaN(num) && String(valueName).trim() !== "") return num;
    return valueName;
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
      item.Property[fallbackProperty.key] = normalizeDirectPropertyValue(valueName, fallbackProperty.values);
      ChatRoomCharacterUpdate(char);
      return { ok: true, msg: `已设置 ${item.Asset.Description} ${fallbackProperty.key}=${item.Property[fallbackProperty.key]}` };
    }

    const dynamicPropertyKey = findDynamicPropertyKey(item.Asset, propName);
    if (dynamicPropertyKey && archetype !== "typed" && archetype !== "modular") {
      item.Property[dynamicPropertyKey] = normalizeDirectPropertyValue(valueName, null);
      ChatRoomCharacterUpdate(char);
      return { ok: true, msg: `已设置 ${item.Asset.Description} ${dynamicPropertyKey}=${item.Property[dynamicPropertyKey]}` };
    }

    if (archetype === "vibrating" || isVibratorAsset(item.Asset)) {
      // 振动器：propName 应该是 "强度" 或 "震动" 或 "模式"
      const idx = VIB_INTENSITY_CN[valueName];
      if (idx === undefined) {
        // 尝试直接按选项名匹配
        const opt = VIBRATOR_OPTIONS.find(o => o.name.toLowerCase() === valueName.toLowerCase());
        if (!opt) return { ok: false, msg: `未知振动档位: ${valueName}` };
        return applyVibratorOption(char, item, opt);
      }
      return applyVibratorOption(char, item, VIBRATOR_OPTIONS[idx]);
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

  function executeItemAdd(memberNumber, itemName, part, color) {
    try {
      const mapping = findItemAsset(itemName);
      if (!mapping) { console.log("[MisakaChat] 未知道具:", itemName); return false; }
      const char = (memberNumber === Player.MemberNumber) ? Player : ChatRoomCharacter.find(c => c.MemberNumber === memberNumber); if (!char) { console.log("[MisakaChat] 找不到玩家 #" + memberNumber); return false; }
      if (!char) return false;
      
      // 如果指定了部位，优先用该部位的 group
      let targetGroup = mapping.group;
      let targetAsset = AssetGet(char.AssetFamily, mapping.group, mapping.asset);
      
      if (part) {
        const groups = BODY_PART_GROUPS[part];
        if (groups) {
          // 在指定部位找一个空的 group
          for (const g of groups) {
            // 检查这个 group 是否有同名 asset
            const partAsset = AssetGet(char.AssetFamily, g, mapping.asset);
            if (partAsset) {
              const existing = char.Appearance.find(a => a?.Asset?.Group?.Name === g);
              if (!existing) {
                targetGroup = g;
                targetAsset = partAsset;
                break;
              }
            }
          }
          // 如果指定部位都有道具了，用第一个有该 asset 的 group 覆盖
          if (targetGroup === mapping.group) {
            for (const g of groups) {
              const partAsset = AssetGet(char.AssetFamily, g, mapping.asset);
              if (partAsset) {
                targetGroup = g;
                targetAsset = partAsset;
                break;
              }
            }
          }
        }
      } else {
        // 没指定部位 — 如果该 group 已有道具，尝试其他 group
        const existing = char.Appearance.find(a => a.Asset?.Group?.Name === mapping.group);
        if (existing) {
          const altGroups = [];
          for (const a of Asset) {
            if (a?.Group?.Name?.startsWith("Item") && a.Name === mapping.asset && a.Group.Name !== mapping.group) {
              altGroups.push(a.Group.Name);
            }
          }
          for (const g of altGroups) {
            const hasItem = char.Appearance.find(a => a?.Asset?.Group?.Name === g);
            if (!hasItem) {
              const altAsset = AssetGet(char.AssetFamily, g, mapping.asset);
              if (altAsset) {
                targetGroup = g;
                targetAsset = altAsset;
                break;
              }
            }
          }
        }
      }
      
      // 颜色覆盖
      let colorOverride = null;
      if (color) {
        const hex = colorNameToHex(color);
        if (hex) {
          const colorSchema = targetAsset?.ColorSchema;
          colorOverride = Array.isArray(colorSchema) ? colorSchema.map(() => hex) : [hex];
        } else {
          console.log("[MisakaChat] 未知颜色:", color);
        }
      }
      // 如果该 group 已有道具且只改颜色，用 directSetColor（保留原有 Property）
      const existingItem = char.Appearance.find(a => a.Asset?.Group?.Name === targetGroup);
      if (existingItem && colorOverride) {
        directSetColor(char, targetGroup, colorOverride);
      } else {
        directSetItem(char, targetGroup, targetAsset, colorOverride);
      }
      ChatRoomCharacterUpdate(char);
      console.log(`[MisakaChat] 已给 #${memberNumber} 添加 ${itemName} (group: ${targetGroup}${part ? ", 部位:" + part : ""}${color ? ", 颜色:" + color : ""})`);
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
    let moveOk = true, itemOk = true, snapOk = true;
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
      } else if (cmd.type === "snapshotSave") {
        snapOk = record(cmd, saveSnapshot(cmd.memberNumber)) && snapOk;
      } else if (cmd.type === "snapshotRestore") {
        snapOk = record(cmd, await executeRestoreSnapshot(cmd.memberNumber)) && snapOk;
      } else if (cmd.type === "copyBonds") {
        snapOk = record(cmd, await executeCopyBonds(cmd.srcNumber, cmd.dstNumber)) && snapOk;
      }
    }
    return { moveOk, itemOk, snapOk, failures };
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
      state.roomJoinLog.push({ name: who, memberNum: data.Sender, time: Date.now(), action: data.Content === "ServerEnter" ? "join" : "leave" });
      if (state.roomJoinLog.length > 50) state.roomJoinLog.shift();
      try { localStorage.setItem("misaka_joinlog", JSON.stringify(state.roomJoinLog)); } catch(e) {}
      // 有人进入时打招呼
      if (data.Content === "ServerEnter" && who) {
        maybeGreetNewcomer(who);
      }
    }

    const validTypes = ["Chat","Talk","Emote","Whisper","Activity","Action"];
    if (!validTypes.includes(data.Type)) return;

    // 把 BC 内部动作消息转成可读文字
    let readableContent = content;
    if (data.Type === "Activity" || data.Type === "Emote") {
      // ChatOther-ItemNose-Pet → "摸了摸鼻子"
      // ChatSelf-ItemMouth-MoanGag → "被口塞住发出呻吟"
      readableContent = content
        .replace(/^Chat(?:Other|Self)-Item([A-Za-z]+)-([A-Za-z]+)$/, (_, part, action) => {
          const partMap = { Mouth:"嘴", Nose:"鼻子", Ears:"耳朵", Feet:"脚", Legs:"腿", Arms:"手臂", Hands:"手", Neck:"脖子", Torso:"身体", Breasts:"胸", Nipples:"乳头", Clit:"明蒂", Vulva:"下体", Penis:"阴茎", Butt:"屁股" };
          const actionMap = { Pet:"摸了摸", Spank:"拍了拍", Slap:"打了一下", Tickle:"挠了挠", Rub:"揉了揉", Kiss:"亲了亲", Lick:"舔了舔", Bite:"咬了一口", Suck:"吸了吸", Pinch:"捏了捏", Grab:"抓住", SlapAss:"拍了屁股", MoanGag:"被口塞住呻吟", MoanGagGiggle:"被口塞住偷笑", Orgasm:"高潮了" };
          const p = partMap[part] || part;
          const a = actionMap[action] || action;
          return `${a}${p}`;
        })
        .replace(/^Orgasm(\d+)?$/, (_, n) => n ? `高潮了(${n})` : "高潮了")
        .replace(/^OrgasmFailSurrender(\d+)?$/, () => "高潮失败了")
        .replace(/^ChatSelf-/, "自己")
        .replace(/^ChatOther-/, "对别人");
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
    const isGimpDoll = senderName.startsWith("GIMP ");

    // roomlog
    try {
      let log = JSON.parse(localStorage.getItem("misaka_roomlog") || "[]");
      log.push({ name: senderName, memberNum: senderNum, content: readableContent.slice(0, 200), type: data.Type, time: now });
      if (log.length > 500) log = log.slice(-500);
      localStorage.setItem("misaka_roomlog", JSON.stringify(log));
    } catch(e) {}

    if (!isGimpDoll) {
      state.recentMessages.push({ senderName: senderName, content: readableContent, senderMemberNumber: senderNum, isSelf: false, time: now });
      if (state.recentMessages.length > 30) state.recentMessages.shift();
      state.lastNonSelfMsgTime = now;  // 更新 idle 计时
    }

    state.messageCount++;
    
    // 触发 context compaction（不阻塞回复）
    if (state.messageCount % CONFIG.compactionInterval === 0 && !state.compactionPending) {
      maybeCompactContext().catch(e => console.warn("[MisakaChat] compaction error:", e.message));
    }
    // 触发长期记忆提炼
    if (state.messageCount % CONFIG.memoryRefineInterval === 0) {
      maybeRefineMemory().catch(e => console.warn("[MisakaChat] refine error:", e.message));
    }

    // 欢迎开关检测（不占用回复名额，不需要 trigger）
    const greetLower = readableContent.toLowerCase();
    const greetOff = /(?:停止|关闭|不要|别|取消|关掉).{0,4}(自动)?欢迎|欢迎.{0,2}(关闭|停止|不要)|stop.*greet/i.test(greetLower);
    const greetOn = /(?:开启|打开|恢复|继续|开始).{0,4}(自动)?欢迎|欢迎.{0,2}(开启|打开|开始)|start.*greet/i.test(greetLower);
    if (greetOff && state.greetEnabled) {
      state.greetEnabled = false;
      try { localStorage.setItem("misaka_greet_enabled", "false"); } catch(e) {}
      try {
        setTimeout(() => {
          if (typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom") {
            ElementValue("InputChat", "好，不自动欢迎了~");
            ChatRoomSendChat();
          }
        }, 1000);
      } catch(e) {}
      return;
    }
    if (greetOn && !state.greetEnabled) {
      state.greetEnabled = true;
      try { localStorage.setItem("misaka_greet_enabled", "true"); } catch(e) {}
      try {
        setTimeout(() => {
          if (typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom") {
            ElementValue("InputChat", "好，自动欢迎已开启~");
            ChatRoomSendChat();
          }
        }, 1000);
      } catch(e) {}
      return;
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
  function normalizeLookupText(value) {
    return String(value || "").toLowerCase().replace(/[\s#＃,，、:：;；.!！?？「」【】（）()_\-]+/g, "");
  }

  function lookupAliases(value) {
    const raw = String(value || "").trim();
    const n = normalizeLookupText(raw);
    const aliases = new Set([raw.toLowerCase(), n]);
    const add = (...items) => items.forEach(item => { aliases.add(String(item||"").toLowerCase()); aliases.add(normalizeLookupText(item)); });
    if (n === "伊水") add("yishui","Eshway","182401");
    return [...aliases].filter(Boolean);
  }

  function scoreLookupCandidate(query, candidate) {
    const q = String(query||"").toLowerCase().trim();
    const qn = normalizeLookupText(q);
    const c = String(candidate||"").toLowerCase().trim();
    const cn = normalizeLookupText(c);
    if (!q||!qn||!c||!cn) return 0;
    if (c === q) return 900;
    if (cn === qn) return 850;
    if (c.startsWith(q)) return 700;
    if (cn.startsWith(qn)) return 650;
    if (qn.length >= 4 && (c.includes(q) || cn.includes(qn))) return 100;
    return 0;
  }

  function bestLookupScore(query, candidate) {
    return Math.max(...lookupAliases(query).map(a => scoreLookupCandidate(a, candidate)));
  }

  async function queryProfile(nameOrId) {
    return new Promise((resolve) => {
      const req = indexedDB.open("bce-past-profiles");
      req.onsuccess = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("profiles")) { resolve(null); return; }
        const tx = db.transaction("profiles","readonly");
        const store = tx.objectStore("profiles");
        const allReq = store.getAll();
        allReq.onsuccess = () => {
          const data = allReq.result || [];
          const query = nameOrId.toLowerCase().trim();
          const matches = data.filter(d => {
            const mn = d.memberNumber ? d.memberNumber.toString() : "";
            return bestLookupScore(query, d.name) > 0 || bestLookupScore(query, d.lastNick) > 0 || bestLookupScore(query, mn) > 0;
          });
          if (matches.length === 0) { resolve(null); return; }
          const score = (d) => {
            const mn = d.memberNumber ? d.memberNumber.toString() : "";
            if (lookupAliases(query).includes(normalizeLookupText(mn))) return 1000;
            return Math.max(bestLookupScore(query,d.name), bestLookupScore(query,d.lastNick), bestLookupScore(query,mn));
          };
          matches.sort((a,b) => (score(b)-score(a)) || ((b.seen||0)-(a.seen||0)));
          resolve(matches.slice(0,3).map(d => {
            const info = { name: d.name, lastNick: d.lastNick||"", memberNumber: d.memberNumber, seen: d.seen ? new Date(d.seen).toLocaleString("zh-CN") : "未知" };
            if (d.characterBundle) {
              try {
                const b = typeof d.characterBundle === "string" ? JSON.parse(d.characterBundle) : d.characterBundle;
                info.nickname = b.Nickname || "";
                info.owner = b.Ownership?.Name ? `${b.Ownership.Name} (#${b.Ownership.MemberNumber})` : "无";
                info.lovers = Array.isArray(b.Lovership) ? b.Lovership.map(l => `${l.Name}${l.Stage===2?"(正式)":""}`).join(", ") : "无";
                info.description = (b.Description||"").slice(0,200);
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
  function parseBCEQueryRequest(content) {
    const text = String(content || "");
    // 只在明确"查询""档案""上次在线""资料"等词出现时才查 BCE
    if (!/(查询|查一下|查查|档案|資料|资料|上次.*在线|上次.*下线|上次.*发言|上次.*出现|profiles?)/i.test(text)) return null;

    const patterns = [
      /(?:查询|查一下|查查|查)\s*[「「【]?(.+?)[」」】]?\s*(?:的)?(?:档案|資料|资料|信息|上次|在线|下线)?.*$/i,
      /[「「【]?(.+?)[」」】]?\s*(?:的)?(?:档案|資料|资料|信息)(?:是什么|是什麼|呢|吗|嗎)?\s*$/i,
      /(?:介绍一下|介绍|说说|讲讲)\s*[「「【]?(.+?)[」」】]?\s*$/i,
      /[「「【]?(.+?)[」」】]?\s*(?:的)?(?:主人|owner|恋人|戀人|lover)(?:是谁|是誰|是|呢|吗|嗎)?\s*$/i,
      /(?:认识|認識|知道|记得|記得)\s*[「「【]?(.+?)[」」】]?\s*(?:吗|嗎|么|嘛)?\s*$/i,
      /[「「【]?(.+?)[」」】]?\s*(?:是誰|是谁|是哪位)\s*$/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m && m[1]) {
        let q = m[1].trim()
          .replace(/^(御坂|御搬|misaka)[,，、\s]*/i, "")
          .replace(/^(你知道|你認識|你认识|知道|認識|认识)\s*/i, "")
          .replace(/^(玩家|角色|成员|id|ID|#|编号)\s*/i, "")
          .replace(/[,，、]\s*(不是|并不是|而不是).+$/i, "")
          .replace(/[？?。.!！,，、：:；;]+$/g, "")
          .trim();
        if (q) return q;
      }
    }
    return null;
  }

  function sanitizeReply(reply) {
    let cleaned = String(reply || "").replace(/^["""''''']+|["""''''']+$/g, "").trim();

    // 截断 thinking/推理段落
    const thinkMarkers = ["等一下","从上下文来看","这里可能有误","也许是","我理解了","让我想想","分析一下","根据上下文","这意味着","我推测","可能是指"];
    for (const marker of thinkMarkers) {
      const idx = cleaned.indexOf(marker);
      if (idx > 0) {
        // 如果 marker 不在开头，截断到 marker 之前
        const before = cleaned.slice(0, idx).trim();
        if (before.length > 5) { cleaned = before; break; }
      }
    }

    const lines = cleaned.split(/\n+/).map(l => l.trim().replace(/^(御[搬坂]|Misaka|misaka)\s*[:：]\s*/i, "").trim()).filter(Boolean);
    cleaned = (lines[0] || cleaned).replace(/^(御[搬坂]|Misaka|misaka)\s*[:：]\s*/i, "");

    // 去除粘连的动作+说话（LLM 没用 | 分隔的情况）
    // 模式：*动作*说话（中间没有 |）
    cleaned = cleaned.replace(/\*([^*]+)\*\s*(?!\|)([^*])/g, (m, action, rest) => {
      // 如果 action 后面直接跟了说话内容（没有|），加上分隔符
      return `*${action}*|${rest}`;
    });

    return cleaned.trim().slice(0, 120);
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

      let reply = "";
      const colorPreferenceQuery = isColorPreferenceQuery(content);
      if (colorPreferenceQuery) {
        const color = findExplicitColorPreference(senderNum, senderName);
        reply = color ? `${color}吧，我记得你明确说过。` : "我没记过，别让我猜。";
      } else {
        const fullPrompt = systemPrompt + preferenceMemoryGuard(content);
        reply = await callLLM(fullPrompt, contextMessages);
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
                    if (r.description) line += `\n描述: ${r.description}`;
                    return line;
                  }).join("\n");
                  extraContext += "\n（档案时间是查看时间不是在线时间。直接用这些信息回答，不要说查不到。）";
                } else {
                  extraContext += `\n\n【BCE档案查询结果：${cmd.target}】\n没有找到这个人的档案。\n`;
                }
              }
            }
            reply = await callLLM(fullPrompt + extraContext, contextMessages);
          }
        }
      }
      if (!reply) return;

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
      if (finalReply.length > 3 && !colorPreferenceQuery) {
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
        // 用 | 分割动作和说话，过滤空段
        const parts = finalReply.split("|").map(p => p.trim()).filter(Boolean);
        const hasAction = parts[0]?.startsWith("*") && parts[0]?.endsWith("*");
        if (hasAction && parts.length >= 2) {
          // 第一段是动作，第二段是说话，分两条发
          ElementValue("InputChat", parts[0]);
          ChatRoomSendChat();
          setTimeout(() => {
            ElementValue("InputChat", parts.slice(1).join(" "));
            ChatRoomSendChat();
          }, 600);
        } else {
          ElementValue("InputChat", finalReply);
          ChatRoomSendChat();
        }
        state.recentMessages.push({ senderName: "御搬", content: finalReply, isSelf: true, time: Date.now() });
        if (state.recentMessages.length > 50) state.recentMessages.shift();
      }

      maybeGenerateSummary();
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
      const mem = loadMemory();
      const apiKeySet = localStorage.getItem(storageKey("apikey")) ? "✅" : "❌";
      const model = localStorage.getItem(storageKey("model")) || CONFIG.model;
      sendLocal(`状态: ${CONFIG.enabled?"开启":"关闭"} | Key: ${apiKeySet} | 模型: ${model} | 认识 ${Object.keys(mem.profiles||{}).length} 人 | 摘要 ${(mem.summaries||[]).length} 条 | 语义记忆 ${state.semanticMemories.length} 条 | 提炼 ${state.refinedMemories.length} 条`);
    } else if (sub === "forget") {
      localStorage.setItem(storageKey("memory"), "{}");
      state.semanticMemories = [];
      state.refinedMemories = [];
      IDB.clearAll();
      sendLocal("🧹 记忆已清空（含 IndexedDB 语义记忆）");
    }
    else if (sub === "memory") {
      const mem = loadMemory();
      const profiles = Object.entries(mem.profiles || {});
      if (profiles.length === 0) sendLocal("记忆为空");
      else profiles.forEach(([mn, info]) => sendLocal(`  ${info.name} (#${mn}): ${info.notes||""} | ${info.chatCount||0}次 | ${info.lastChat||""}`));
    } else if (sub === "persona" && parts[1]) {
      localStorage.setItem(storageKey("persona_extra"), parts.slice(1).join(" "));
      sendLocal("📝 人设附加备注已更新");
    } else {
      sendLocal("用法: /misaka on|off|key <key>|model <name>|status|forget|memory|persona <text>");
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

  // === Debug 接口 ===
  window.__misakaGetState = function() {
    return {
      enabled: CONFIG.enabled, busy: state.busy, lastReplyTime: state.lastReplyTime,
      greetEnabled: state.greetEnabled,
      messageCount: state.messageCount, recentMsgs: state.recentMessages.slice(-5),
      model: CONFIG.model, hasApiKey: !!(localStorage.getItem(storageKey("apikey"))||""),
      hasPersona: typeof MisakaPersona !== "undefined"
    };
  };

  window.__misakaDebugQuery = async function(target) {
    return await queryProfile(target);
  };

  window.__misakaDebugRoster = function() {
    if (typeof MisakaPersona === "undefined" || typeof ChatRoomCharacter === "undefined" || typeof Player === "undefined") return null;
    return MisakaPersona.buildCompactRoster(ChatRoomCharacter, Player.MemberNumber);
  };

  window.__misakaDebugParseBCE = function(content) {
    return parseBCEQueryRequest(content);
  };

  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(init, 2000);
  else window.addEventListener("load", () => setTimeout(init, 2000));
})();
