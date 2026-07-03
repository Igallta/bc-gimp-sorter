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
    maxTokens: 1500,
    temperature: 0.8,
    maxContext: 50,
    cooldownMs: 3000,
    perUserCooldownMs: 5000,
    apiKeyTimeout: 15000,
    replyDelayMs: 800,
    maxProfileEntries: 20,
    maxSummaries: 50,
    summaryInterval: 30,
    moveCooldownMs: 5000,  // 移动操作冷却
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
  };

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

  // === API 调用 ===
  async function callLLM(systemPrompt, contextMessages) {
    const apiKey = localStorage.getItem(storageKey("apikey")) || "";
    if (!apiKey) { console.warn("[MisakaChat] 未设置 API key"); return null; }
    const messages = [{ role: "system", content: systemPrompt }, ...contextMessages];

    return new Promise((resolve) => {
      const doRequest = (url, model, isFallback) => {
        const reqBody = JSON.stringify({ model, messages, max_tokens: CONFIG.maxTokens, temperature: CONFIG.temperature });
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
                if (data.choices?.length > 0) resolve(data.choices[0].message.content.trim());
                else if (!isFallback) doRequest(url, CONFIG.fallbackModel, true);
                else resolve(null);
              } catch (e) {
                if (!isFallback) doRequest(url, CONFIG.fallbackModel, true);
                else resolve(null);
              }
            },
            onerror: () => { if (!isFallback) doRequest(url, CONFIG.fallbackModel, true); else resolve(null); },
            ontimeout: () => { if (!isFallback) doRequest(url, CONFIG.fallbackModel, true); else resolve(null); }
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
              if (data.choices?.length > 0) resolve(data.choices[0].message.content.trim());
              else if (!isFallback) doRequest(url, CONFIG.fallbackModel, true);
              else resolve(null);
            } catch (e) {
              if (!isFallback) doRequest(url, CONFIG.fallbackModel, true);
              else resolve(null);
            }
          };
          xhr.onerror = () => { if (!isFallback) doRequest(url, CONFIG.fallbackModel, true); else resolve(null); };
          xhr.ontimeout = () => { if (!isFallback) doRequest(url, CONFIG.fallbackModel, true); else resolve(null); };
          xhr.send(reqBody);
        }
      };
      doRequest(CONFIG.apiBase, CONFIG.model, false);
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
            (a?.Asset?.Description === searchName || a?.Asset?.Description === itemName ||
             a?.Asset?.Description?.includes(searchName) || a?.Asset?.Description?.includes(itemName))
          );
          if (item) return item;
        }
      }
    }
    // 不限定部位 — 精确匹配
    let target = char.Appearance.find(a => 
      a?.Asset?.Group?.Name?.startsWith("Item") && 
      a?.Asset?.Description === searchName
    );
    if (!target && searchName !== itemName) {
      target = char.Appearance.find(a => 
        a?.Asset?.Group?.Name?.startsWith("Item") && 
        a?.Asset?.Description === itemName
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
  
  function findItemAsset(itemName) {
    if (!itemName) return null;
    // 同义词转换
    itemName = SYNONYMS[itemName] || itemName;
    // 模糊同义词：包含"绳"字的都映射到"麻绳"
    if (itemName.includes("绳") && !itemName.includes("颈") && !itemName.includes("纯")) itemName = "麻绳";
    if (itemName.includes("口塞") && !itemName.includes("模块")) itemName = "口球";
    if (typeof Asset === "undefined" || !Array.isArray(Asset)) return null;
    const family = Player.AssetFamily;
    
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
        if (isMatch && a.Description === itemName) {
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
        if (isMatch && a.Description && a.Description.includes(itemName)) {
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
        if (isMatch && a.Description && itemName.includes(a.Description)) {
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
    return true;
  }

  function directRemoveItem(char, groupName) {
    if (!char) return false;
    const idx = char.Appearance.findIndex(a => a.Asset?.Group?.Name === groupName);
    if (idx < 0) return false;
    char.Appearance.splice(idx, 1);
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
    if (/^#[0-9A-Fa-f]{6}$/.test(n)) return n.toUpperCase();
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

  // typed 道具常见中文样式名 → TypeRecord.typed 索引
  // 按 道具名+样式名 查找
  const TYPED_STYLE_CN = {
    "麻绳": { "基础": 0, "悬吊": 1, "倒吊": 2, "普通": 0, "悬挂": 1 },
    "尼龙绳": { "基础": 0, "普通": 0, "上半": 0, "下半": 1, "青蛙绑": 2, "展鹰": 2 },
    "皮革脚铐": { "链条": 0, "普通": 0, "铐": 1, "环": 2, "锁": 3 },
    "皮革豪华脚铐": { "链条": 0, "铐": 1, "环": 2, "桶": 3, "锁": 4 },
    "皮革腿铐": { "链条": 0, "铐": 1, "环": 2, "锁": 3 },
    "皮革手铐": { "铐": 0, "普通": 0, "环": 1, "锁": 2 },
    "皮革豪华手铐": { "铐": 0, "环": 1, "桶": 2, "锁": 3 },
    "口球": { "球": 0, "普通": 0, "带子": 1, "锁": 2 },
    "马具口球": { "球": 0, "马具": 1, "锁": 2 },
    "折叠屏风": { "关": 0, "关闭": 0, "合": 0, "开": 1, "展开": 1, "打开": 1 },
    "乳胶束腰": { "基础": 0, "普通": 0, "吊带": 1, "锁": 2 },
    "重金属脚铐": { "链条": 0, "铐": 1 },
    "闪亮绑腿器": { "乳胶": 0, "皮带": 4, "金属": 8, "锁": 20 },
    "闪亮单手套": { "束缚": 0, "普通": 0, "带子": 1, "硬": 2, "反": 3, "X交叉": 4, "锁": 17 },
    "衬套连指手套": { "手套": 0, "普通": 0, "带子": 1, "扣": 2, "链": 3, "锁": 5 },
    "未来贞操文胸": { "显示": 0, "锁": 1, "文字": 2, "网格": 3, "文胸": 5 },
    "禁制贞操文胸": { "文胸": 0, "金属": 1, "细节": 2, "电击": 3, "灯": 4 },
  };

  // 在 setExtendedItemProperty 的 typed 分支里用中文映射
  function findTypedIndex(item, valueName) {
    const assetName = item?.Asset?.Description || "";
    // 先查 TYPED_STYLE_CN
    if (TYPED_STYLE_CN[assetName] && TYPED_STYLE_CN[assetName][valueName] !== undefined) {
      return TYPED_STYLE_CN[assetName][valueName];
    }
    // 尝试数字
    const num = parseInt(valueName);
    if (!isNaN(num)) return num;
    // 尝试英文选项名匹配（运行时查询）
    try {
      const cfg = item.Asset?.ExtendedItemConfig || AssetFindExtendedConfig(item.Asset);
      if (cfg?.Options) {
        const idx = cfg.Options.findIndex(o => o.Name === valueName || o.Name?.toLowerCase() === valueName.toLowerCase());
        if (idx >= 0) return idx;
      }
    } catch(e) {}
    return null;
  }

  // 通用：设置 Extended 道具属性
  function setExtendedItemProperty(char, item, propName, valueName) {
    if (!item || !item.Asset) return { ok: false, msg: "道具不存在" };
    if (item.Property?.LockedBy) return { ok: false, msg: "道具被锁" };

    const archetype = item.Asset.Archetype;
    if (!item.Property) item.Property = {};
    if (!item.Property.TypeRecord) item.Property.TypeRecord = {};

    if (archetype === "vibrating") {
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
      const typeIdx = findTypedIndex(item, valueName);
      if (typeIdx === null) return { ok: false, msg: `无法识别样式: ${valueName}（道具: ${item.Asset.Description}）` };
      item.Property.TypeRecord.typed = typeIdx;
      CharacterRefresh(char, false, false);
      return { ok: true, msg: `已设置 ${item.Asset.Description} 样式=${typeIdx}` };
    }

    if (archetype === "modular") {
      // modular 道具：TypeRecord 有多个 key
      // propName 格式：模块key（如 g/h/c/b/e），valueName：索引
      const trKey = propName;
      let typeIdx = parseInt(valueName);
      if (isNaN(typeIdx)) return { ok: false, msg: `modular 模块 ${trKey} 需要数字索引: ${valueName}` };
      item.Property.TypeRecord[trKey] = typeIdx;
      CharacterRefresh(char, false, false);
      return { ok: true, msg: `已设置 ${item.Asset.Description} 模块 ${trKey}=${typeIdx}` };
    }

    // 非 Extended 道具 — 直接设 Property
    if (!item.Property) item.Property = {};
    item.Property[propName] = valueName;
    CharacterRefresh(char, false, false);
    return { ok: true, msg: `已设置 ${item.Asset.Description} ${propName}=${valueName}` };
  }

  function applyVibratorOption(char, item, opt) {
    if (!item.Property) item.Property = {};
    if (!item.Property.TypeRecord) item.Property.TypeRecord = {};
    
    // 保留锁字段
    const lockFields = {};
    for (const k of ["LockedBy","LockMemberNumber","LockMemberName","Name","OverridePriority"]) {
      if (item.Property[k] !== undefined) lockFields[k] = item.Property[k];
    }
    
    item.Property.Mode = opt.mode;
    item.Property.Intensity = opt.intensity;
    item.Property.Effect = [...opt.effect];
    
    // 找到 TypeRecord 里的 vibrating key
    const trKey = Object.keys(item.Property.TypeRecord)[0] || "vibrating";
    item.Property.TypeRecord[trKey] = opt.tr;
    
    // 恢复锁字段
    Object.assign(item.Property, lockFields);
    
    CharacterRefresh(char, false, false);
    return { ok: true, msg: `已设置 ${item.Asset.Description} ${opt.name}` };
  }

  // 设置已有道具的属性（强度/绑法/开关等）
  function executeItemSet(memberNumber, itemName, part, propName, valueName) {
    try {
      const char = ChatRoomCharacter.find(c => c.MemberNumber === memberNumber) || Player;
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
      const char = ChatRoomCharacter.find(c => c.MemberNumber === memberNumber) || Player;
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
      directSetItem(char, targetGroup, targetAsset, colorOverride);
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
      const char = ChatRoomCharacter.find(c => c.MemberNumber === memberNumber) || Player;
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
      const char = ChatRoomCharacter.find(c => c.MemberNumber === memberNumber) || Player;
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
    for (const cmd of commands) {
      if (cmd.type === "move") {
        moveOk = executeMove(cmd.memberNumber, cmd.direction);
      } else if (cmd.type === "moveTo") {
        moveOk = await executeMoveTo(cmd.memberNumber, cmd.targetNumber, cmd.side);
      } else if (cmd.type === "moveEdge") {
        moveOk = await executeMoveEdge(cmd.memberNumber, cmd.edge);
      } else if (cmd.type === "itemadd") {
        itemOk = executeItemAdd(cmd.memberNumber, cmd.item, cmd.part, cmd.color);
      } else if (cmd.type === "itemset") {
        itemOk = executeItemSet(cmd.memberNumber, cmd.item, cmd.part, cmd.property, cmd.value);
      } else if (cmd.type === "itemdel") {
        console.log(`[MisakaChat] CMD itemdel #${cmd.memberNumber} item="${cmd.item}" part="${cmd.part||""}"`);
        itemOk = executeItemDel(cmd.memberNumber, cmd.item, cmd.part);
      } else if (cmd.type === "itemdelall") {
        console.log(`[MisakaChat] CMD itemdelall #${cmd.memberNumber}`);
        itemOk = executeItemDelAll(cmd.memberNumber);
      } else if (cmd.type === "snapshotSave") {
        snapOk = saveSnapshot(cmd.memberNumber);
      } else if (cmd.type === "snapshotRestore") {
        snapOk = await executeRestoreSnapshot(cmd.memberNumber);
      } else if (cmd.type === "copyBonds") {
        snapOk = await executeCopyBonds(cmd.srcNumber, cmd.dstNumber);
      }
    }
    return { moveOk, itemOk, snapOk };
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
    }

    const validTypes = ["Chat","Talk","Emote","Whisper","Activity"];
    if (!validTypes.includes(data.Type)) return;

    const key = senderNum + ":" + content + ":" + data.Type;
    const now = Date.now();
    if (window.__misakaLastKey === key && now - (window.__misakaLastKeyTime || 0) < 10000) return;
    window.__misakaLastKey = key;
    window.__misakaLastKeyTime = now;

    if (senderNum === Player.MemberNumber) {
      state.recentMessages.push({ senderName: "御搬", content, isSelf: true, time: now });
      return;
    }

    const senderChar = ChatRoomCharacter.find(c => c.MemberNumber === senderNum);
    const senderName = (senderChar?.Nickname || senderChar?.Name) || ("#" + senderNum);
    const isGimpDoll = senderName.startsWith("GIMP ");

    // roomlog
    try {
      let log = JSON.parse(localStorage.getItem("misaka_roomlog") || "[]");
      log.push({ name: senderName, memberNum: senderNum, content: content.slice(0, 200), type: data.Type, time: now });
      if (log.length > 500) log = log.slice(-500);
      localStorage.setItem("misaka_roomlog", JSON.stringify(log));
    } catch(e) {}

    if (!isGimpDoll) {
      state.recentMessages.push({ senderName: senderName, content, senderMemberNumber: senderNum, isSelf: false, time: now });
      if (state.recentMessages.length > 30) state.recentMessages.shift();
    }

    state.messageCount++;

    const triggers = ["misaka","御搬","御坂","misaki的","搬运工"];
    const lower = content.toLowerCase();
    const triggered = triggers.some(t => lower.includes(t.toLowerCase()));
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

    handleReply(senderNum, senderName, content).finally(() => clearTimeout(replyTimeout));
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

      // BCE 查询（仅明确查档时）
      const bceTarget = parseBCEQueryRequest(content);
      let bceInfo = "";
      if (bceTarget) {
        const results = await queryProfile(bceTarget);
        if (results) {
          bceInfo = "\n\n【BCE档案查询结果：" + bceTarget + "】\n";
          bceInfo += results.map(r => {
            let line = `${r.lastNick || r.name} (#${r.memberNumber}) - 档案查看: ${r.seen}`;
            if (r.owner && r.owner !== "无") line += ` | 主人: ${r.owner}`;
            if (r.lovers && r.lovers !== "无") line += ` | 恋人: ${r.lovers}`;
            if (r.itemCount !== undefined) line += ` | ${r.itemCount}件束缚, ${r.lockCount}把锁`;
            if (r.description) line += `\n描述: ${r.description}`;
            return line;
          }).join("\n");
          bceInfo += "\n（档案时间是查看时间不是在线时间。直接用这些信息回答，不要说查不到。）";
        }
      }

      const fullPrompt = systemPrompt + bceInfo;
      const reply = await callLLM(fullPrompt, contextMessages);
      if (!reply) return;

      // 解析操作指令
      const { commands, cleaned } = parseActionCommands(reply);
      let finalReply = sanitizeReply(cleaned);

      // 执行操作
      if (commands.length > 0) {
        const result = await executeCommands(commands);
        console.log("[MisakaChat] 操作执行:", commands, result);
      }

      if (!finalReply) return;

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
        const parts = finalReply.split("|");
        if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
          ElementValue("InputChat", parts[0].trim());
          ChatRoomSendChat();
          setTimeout(() => {
            ElementValue("InputChat", parts[1].trim());
            ChatRoomSendChat();
          }, 600);
        } else {
          ElementValue("InputChat", finalReply);
          ChatRoomSendChat();
        }
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
      sendLocal(`状态: ${CONFIG.enabled?"开启":"关闭"} | Key: ${apiKeySet} | 模型: ${model} | 认识 ${Object.keys(mem.profiles||{}).length} 人 | 摘要 ${(mem.summaries||[]).length} 条`);
    } else if (sub === "forget") { localStorage.setItem(storageKey("memory"), "{}"); sendLocal("🧹 记忆已清空"); }
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
  }

  // === Debug 接口 ===
  window.__misakaGetState = function() {
    return {
      enabled: CONFIG.enabled, busy: state.busy, lastReplyTime: state.lastReplyTime,
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