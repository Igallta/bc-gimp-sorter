// MisakaChat v1.0 — BC 御坂自动回复系统
// 独立调用大模型 API，不依赖 OpenClaw
// 通过 Tampermonkey 加载，GM_setValue 持久化记忆

(function() {
  "use strict";

  // === 单例保护：杀掉旧实例 ===
  if (window.__misakaInstance) {
    console.log("[MisakaChat] 杀掉旧实例 #" + window.__misakaInstance);
    // 无法真正销毁旧 IIFE，但可以让它失效
  }
  window.__misakaInstance = Date.now();
  const myInstance = window.__misakaInstance;
  function isCurrent() { return window.__misakaInstance === myInstance; }

  // === 配置 ===
  const CONFIG = {
    enabled: true,
    apiBase: "https://openrouter.ai/api/v1/chat/completions",
    model: "deepseek/deepseek-v4-pro",
    fallbackModel: "openai/gpt-4o-mini",
    maxTokens: 100,
    temperature: 0.8,
    maxContext: 50,          // 上下文消息条数
    cooldownMs: 3000,        // 两次回复最小间隔
    perUserCooldownMs: 5000,  // 同一用户连续回复间隔
    idleTimeoutMs: 300000,   // 5 分钟无人说话进入安静模式
    apiKeyTimeout: 10000,   // API 调用超时
    replyDelayMs: 800,      // 回复前最小延迟（模拟自然节奏）
    maxProfileEntries: 20,   // 最多记住多少人
    maxSummaries: 50,        // 最多存多少条日志摘要
    summaryInterval: 30,    // 每 N 条对话生成一次摘要
  };

  // === 状态 ===
  let state = {
    recentMessages: [],   // 滑动窗口
    lastReplyTime: 0,
    lastReplyTo: null,
    lastUserReplyTime: {}, // memberNumber -> timestamp
    messageCount: 0,
    idleMode: false,
    busy: false,
  };

  // === 记忆系统 (GM_setValue 持久化) ===
  function storageKey(prefix) { return "misaka_" + prefix; }

  function loadMemory() {
    try {
      const raw = localStorage.getItem(storageKey("memory")) || "{}";
      return JSON.parse(raw);
    } catch (e) {
      return { profiles: {}, summaries: [] };
    }
  }

  function saveMemory(mem) {
    try {
      localStorage.setItem(storageKey("memory"), JSON.stringify(mem));
    } catch (e) {
      console.error("[MisakaChat] 保存记忆失败:", e.message);
    }
  }

  function updateProfile(memberNumber, name, content) {
    const mem = loadMemory();
    if (!mem.profiles) mem.profiles = {};
    
    const existing = mem.profiles[memberNumber] || {
      name: name,
      firstSeen: new Date().toISOString().slice(0, 10),
      notes: "",
      chatCount: 0,
      lastChat: null
    };
    
    existing.name = name || existing.name;
    existing.chatCount = (existing.chatCount || 0) + 1;
    existing.lastChat = new Date().toISOString().slice(0, 16).replace("T", " ");
    
    // 如果没有 notes，尝试从对话内容提取一个简短印象
    if (!existing.notes && content) {
      // 简单关键词提取（后续可让模型做）
      const lower = content.toLowerCase();
      if (/kidnap|绑架/.test(lower)) existing.notes = "喜欢绑架";
      else if (/hug|抱/.test(lower)) existing.notes = "喜欢抱抱";
      else if (/pet|宠物/.test(lower)) existing.notes = "当宠物玩";
      else if (/tie|绑|rope/.test(lower)) existing.notes = "喜欢束缚";
      else existing.notes = "常客";
    }
    
    mem.profiles[memberNumber] = existing;
    
    // 淘汰最久没互动的人
    const profileKeys = Object.keys(mem.profiles);
    if (profileKeys.length > CONFIG.maxProfileEntries) {
      profileKeys.sort((a, b) => {
        const ta = new Date(mem.profiles[a].lastChat || 0).getTime();
        const tb = new Date(mem.profiles[b].lastChat || 0).getTime();
        return ta - tb;
      });
      delete mem.profiles[profileKeys[0]];
    }
    
    saveMemory(mem);
  }

  function maybeGenerateSummary() {
    if (state.messageCount % CONFIG.summaryInterval !== 0) return;
    const mem = loadMemory();
    if (!mem.summaries) mem.summaries = [];
    
    // 简单摘要：取最近几条消息的发送者和内容片段
    const recent = state.recentMessages.slice(-CONFIG.summaryInterval);
    const senders = [...new Set(recent.map(m => m.senderName))];
    const summary = `${new Date().toISOString().slice(5, 16)}: ${senders.join("、")} 在房间里聊了天`;
    
    mem.summaries.push(summary);
    if (mem.summaries.length > CONFIG.maxSummaries) {
      // 合并最早的
      const old = mem.summaries.slice(0, 2).join("；");
      mem.summaries = [old, ...mem.summaries.slice(2)];
    }
    saveMemory(mem);
  }

  // === API 调用 ===
  async function callLLM(systemPrompt, contextMessages) {
    const apiKey = localStorage.getItem(storageKey("apikey")) || "";
    if (!apiKey) {
      console.warn("[MisakaChat] 未设置 API key");
      return null;
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...contextMessages,
    ];

    const body = JSON.stringify({
      model: CONFIG.model,
      messages: messages,
      max_tokens: CONFIG.maxTokens,
      temperature: CONFIG.temperature,
    });

    // 优先用 GM_xmlhttpRequest（油猴注入到 window），回退到 fetch
    const useGM = typeof window.__GM_xmlhttpRequest !== "undefined";

    return new Promise((resolve) => {
      const doRequest = (url, model, isFallback) => {
        const reqBody = JSON.stringify({
          model: model,
          messages: messages,
          max_tokens: CONFIG.maxTokens,
          temperature: CONFIG.temperature,
        });

        if (useGM) {
          window.__GM_xmlhttpRequest({
            method: "POST",
            url: url,
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + apiKey,
              "HTTP-Referer": "https://igallta.github.io/bc-gimp-sorter/",
              "X-Title": "Misaka BC Chat"
            },
            data: reqBody,
            timeout: CONFIG.apiKeyTimeout,
            onload: (resp) => {
              try {
                const data = JSON.parse(resp.responseText);
                if (data.choices && data.choices.length > 0) {
                  resolve(data.choices[0].message.content.trim());
                } else if (!isFallback && CONFIG.fallbackModel && model !== CONFIG.fallbackModel) {
                  doRequest(url, CONFIG.fallbackModel, true);
                } else {
                  resolve(null);
                }
              } catch (e) {
                console.error("[MisakaChat] 解析响应失败:", e.message);
                if (!isFallback && CONFIG.fallbackModel && model !== CONFIG.fallbackModel) {
                  doRequest(url, CONFIG.fallbackModel, true);
                } else {
                  resolve(null);
                }
              }
            },
            onerror: () => resolve(null),
            ontimeout: () => {
              if (!isFallback && CONFIG.fallbackModel && model !== CONFIG.fallbackModel) {
                doRequest(url, CONFIG.fallbackModel, true);
              } else {
                resolve(null);
              }
            }
          });
        } else {
          // XHR 回退（BC CSP 拦 fetch 但不拦 XHR）
          const xhr = new XMLHttpRequest();
          xhr.open("POST", url, true);
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.setRequestHeader("Authorization", "Bearer " + apiKey);
          xhr.setRequestHeader("HTTP-Referer", "https://igallta.github.io/bc-gimp-sorter/");
          xhr.setRequestHeader("X-Title", "Misaka BC Chat");
          xhr.timeout = CONFIG.apiKeyTimeout;
          xhr.onload = () => {
            try {
              const data = JSON.parse(xhr.responseText);
              if (data.choices && data.choices.length > 0) {
                resolve(data.choices[0].message.content.trim());
              } else if (!isFallback && CONFIG.fallbackModel && model !== CONFIG.fallbackModel) {
                doRequest(url, CONFIG.fallbackModel, true);
              } else {
                resolve(null);
              }
            } catch (e) {
              if (!isFallback && CONFIG.fallbackModel && model !== CONFIG.fallbackModel) {
                doRequest(url, CONFIG.fallbackModel, true);
              } else {
                resolve(null);
              }
            }
          };
          xhr.onerror = () => {
            if (!isFallback && CONFIG.fallbackModel && model !== CONFIG.fallbackModel) {
              doRequest(url, CONFIG.fallbackModel, true);
            } else {
              resolve(null);
            }
          };
          xhr.ontimeout = () => {
            if (!isFallback && CONFIG.fallbackModel && model !== CONFIG.fallbackModel) {
              doRequest(url, CONFIG.fallbackModel, true);
            } else {
              resolve(null);
            }
          };
          xhr.send(reqBody);
        }
      };

      doRequest(CONFIG.apiBase, CONFIG.model, false);
    });
  }

  // === 人设加载 ===
  function getSystemPrompt() {
    const mem = loadMemory();
    // 如果 misaka-persona.js 已加载
    if (typeof MisakaPersona !== "undefined") {
      return MisakaPersona.build(mem);
    }
    // 内置 fallback
    return `你是御坂 (Misaka)，Bondage Club 中 Gimp Dolls 房间的管理员。安静、简短、偶尔傲娇。中文为主，回复不超过50字。不提及AI或现实信息。`;
  }

  // === 消息处理 ===
  // 防重复：用 window 级别去重（避免多 IIFE 实例各自有自己的 key）
  function onChatRoomMessage(data) {
    if (!isCurrent()) return; // 旧实例忽略
    if (!CONFIG.enabled) return;
    if (typeof Player === "undefined" || !Player) return;
    
    // BC ServerSocket 事件数据结构: { Sender, Content, Type, Dictionary }
    // Sender = MemberNumber (number), Content = 消息内容, Type = 消息类型
    const content = data.Content || "";
    const senderNum = data.Sender;
    
    // 只处理实际聊天消息，过滤掉 mod 内部消息
    const validTypes = ["Chat", "Talk", "Emote", "Whisper", "Activity"];
    if (!validTypes.includes(data.Type)) return;

    // 防重复：同一条消息 10 秒内只处理一次（window 级别）
    const key = senderNum + ":" + content + ":" + data.Type;
    const now = Date.now();
    if (window.__misakaLastKey === key && now - (window.__misakaLastKeyTime || 0) < 10000) return;
    window.__misakaLastKey = key;
    window.__misakaLastKeyTime = now;
    
    // 忽略自己的消息
    if (senderNum === Player.MemberNumber) {
      state.recentMessages.push({
        senderName: "御搬",
        content: content,
        isSelf: true,
        time: Date.now()
      });
      return;
    }

    // 从 ChatRoomCharacter 查找发送者名字
    const senderChar = ChatRoomCharacter.find(c => c.MemberNumber === senderNum);
    const senderName = (senderChar && (senderChar.Nickname || senderChar.Name)) || ("#" + senderNum);

    // GIMP 娃娃的消息不记录到上下文
    const isGimpDoll = senderName.startsWith("GIMP ");
    
    // 记录到本地 roomlog（所有消息，包括系统消息）
    try {
      let log = JSON.parse(localStorage.getItem("misaka_roomlog") || "[]");
      log.push({
        name: senderName,
        memberNum: senderNum,
        content: content.slice(0, 200),
        type: data.Type,
        time: Date.now()
      });
      if (log.length > 500) log = log.slice(-500);
      localStorage.setItem("misaka_roomlog", JSON.stringify(log));
    } catch(e) {}
    
    // 记录房间进出事件（系统消息）
    if (data.Type === "Action" || data.Type === "LocalMessage" || data.Type === "ServerMessage") {
      if (/进来了|进入了|加入了/.test(content)) {
        const match = content.match(/^(.+?)\s*进[来了入]|^(.+?)\s*加入了/);
        const who = match ? (match[1] || match[2]).trim() : senderName;
        state.roomJoinLog = state.roomJoinLog || [];
        state.roomJoinLog.push({ name: who, time: Date.now(), action: "join" });
        if (state.roomJoinLog.length > 50) state.roomJoinLog.shift();
      }
      if (/掉了|掉线了|离开了|退出了/.test(content)) {
        const match = content.match(/^(.+?)\s*(?:掉了|掉线了|离开了|退出了)/);
        const who = match ? match[1].trim() : senderName;
        state.roomJoinLog = state.roomJoinLog || [];
        state.roomJoinLog.push({ name: who, time: Date.now(), action: "leave" });
        if (state.roomJoinLog.length > 50) state.roomJoinLog.shift();
      }
    }

    // 更新消息窗口
    if (!isGimpDoll) {
      state.recentMessages.push({
        senderName: senderName,
        content: content,
        senderMemberNumber: senderNum,
        isSelf: false,
        time: Date.now()
      });
      if (state.recentMessages.length > 30) state.recentMessages.shift();
    }

    state.messageCount++;
    state.idleMode = false;

    // 更新人物档案
    updateProfile(senderNum, senderName, content);

    // 检查触发词
    const triggers = ["misaka", "御搬", "御坂"];
    const lower = content.toLowerCase();
    const triggered = triggers.some(t => lower.includes(t.toLowerCase()));

    if (!triggered) return;
    if (state.busy) return;
    // window 级别 busy 锁
    if (window.__misakaGlobalBusy) return;
    // 更硬的锁：正在回复中
    if (window.__misakaReplyInProgress) return;

    // 频率控制（在设锁之前检查）
    const nowTime = Date.now();
    if (nowTime - state.lastReplyTime < CONFIG.cooldownMs) return;
    const lastUserTime = state.lastUserReplyTime[senderNum] || 0;
    if (nowTime - lastUserTime < CONFIG.perUserCooldownMs) return;

    // 通过所有检查后才设锁
    window.__misakaGlobalBusy = true;
    window.__misakaReplyInProgress = true;

    // 触发回复
    handleReply(senderNum, senderName, content);
  }

  // 从 BCE profiles 数据库查询玩家档案
  async function queryProfile(nameOrId) {
    return new Promise((resolve) => {
      const req = indexedDB.open("bce-past-profiles");
      req.onsuccess = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("profiles")) {
          resolve(null);
          return;
        }
        const tx = db.transaction("profiles", "readonly");
        const store = tx.objectStore("profiles");
        allReq = store.getAll();
        allReq.onsuccess = () => {
          const data = allReq.result || [];
          const query = nameOrId.toLowerCase().trim();
          const matches = data.filter(d => {
            const name = (d.name || "").toLowerCase();
            const nick = (d.lastNick || "").toLowerCase();
            const mn = d.memberNumber ? d.memberNumber.toString() : "";
            return name.includes(query) || nick.includes(query) || mn.includes(query);
          });
          if (matches.length === 0) {
            resolve(null);
            return;
          }
          matches.sort((a, b) => (b.seen || 0) - (a.seen || 0));
          const top = matches.slice(0, 3).map(d => {
            const info = {
              name: d.name,
              lastNick: d.lastNick || "",
              memberNumber: d.memberNumber,
              seen: d.seen ? new Date(d.seen).toLocaleString("zh-CN") : "未知"
            };
            // 解析 characterBundle 获取更多详情
            if (d.characterBundle) {
              try {
                const bundle = typeof d.characterBundle === "string" 
                  ? JSON.parse(d.characterBundle) 
                  : d.characterBundle;
                info.nickname = bundle.Nickname || "";
                info.owner = bundle.Ownership && bundle.Ownership.Name 
                  ? `${bundle.Ownership.Name} (#${bundle.Ownership.MemberNumber})` 
                  : "无";
                info.lovers = Array.isArray(bundle.Lovership) 
                  ? bundle.Lovership.map(l => `${l.Name}${l.Stage === 2 ? "(正式)" : ""}`).join(", ")
                  : "无";
                info.description = (bundle.Description || "").slice(0, 200);
                // 穿着统计
                if (Array.isArray(bundle.Appearance)) {
                  let lockCount = 0, itemCount = 0;
                  for (const a of bundle.Appearance) {
                    if (a.Asset && a.Asset.Group && a.Asset.Group.Name.startsWith("Item")) itemCount++;
                    if (a.Property && a.Property.LockedBy) lockCount++;
                  }
                  info.itemCount = itemCount;
                  info.lockCount = lockCount;
                }
              } catch(e) {}
            }
            return info;
          });
          resolve(top);
        };
        allReq.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  }

  // 检测是否是查询请求
  function parseQueryRequest(content) {
    // 匹配"查询XX"、"查XX"、"XX上次在线"、"XX上次发言"、"XX下线时间"等
    const patterns = [
      /(?:查询|查一下|查查|查)\s*[「「【]?(.+?)[」」】]?(?:上次|的).*(?:在线|下线|发言|出现|登录|来过)/i,
      /(?:查询|查一下|查查|查)\s*[「「【]?(.+?)[」」】]?/i,
      /[「「【]?(.+?)[」」】]?(?:上次|的).*(?:在线|下线|发言|出现|登录|来过)/i,
    ];
    for (const p of patterns) {
      const m = content.match(p);
      if (m && m[1]) return m[1].trim();
    }
    return null;
  }

  async function handleReply(senderNum, senderName, content) {
    state.busy = true;
    window.__misakaGlobalBusy = true;
    state.lastReplyTime = Date.now();
    state.lastUserReplyTime[senderNum] = Date.now();

    try {
      // 等待最小延迟
      await new Promise(r => setTimeout(r, CONFIG.replyDelayMs));

      // 读取发送者和房间信息
      let profileInfo = "";
      if (typeof MisakaPersona !== "undefined" && typeof ChatRoomCharacter !== "undefined") {
        // 御坂自己的信息
        const myChar = ChatRoomCharacter.find(c => c.MemberNumber === Player.MemberNumber);
        const myProfile = MisakaPersona.extractProfile(myChar);
        if (myProfile) {
          profileInfo += `\n\n【你的资料】${myProfile.name} (#${myProfile.memberNumber})`;
          if (myProfile.ds) profileInfo += ` | ${myProfile.ds}`;
          if (myProfile.owner) profileInfo += ` | ${myProfile.owner}`;
          if (myProfile.lover) profileInfo += ` | ${myProfile.lover}`;
          if (myProfile.description) profileInfo += `\n描述: ${myProfile.description}`;
          if (myProfile.appearance) profileInfo += `\n束缚物品: ${myProfile.appearance}`;
          if (myProfile.lockCount) profileInfo += `\n锁数量: ${myProfile.lockCount}`;
          if (myProfile.itemCount) profileInfo += `\n束缚件数: ${myProfile.itemCount}`;
        }

        // 发送者的详细资料
        const char = ChatRoomCharacter.find(c => c.MemberNumber === senderNum);
        const profile = MisakaPersona.extractProfile(char);
        if (profile) {
          profileInfo += `\n\n【发送者资料】${profile.name} (#${profile.memberNumber})`;
          if (profile.ds) profileInfo += ` | ${profile.ds}`;
          if (profile.languages) profileInfo += ` | ${profile.languages.join("/")}`;
          if (profile.owner) profileInfo += ` | ${profile.owner}`;
          if (profile.lover) profileInfo += ` | ${profile.lover}`;
          if (profile.description) profileInfo += `\n描述: ${profile.description}`;
          if (profile.appearance) profileInfo += `\n束缚物品: ${profile.appearance}`;
          if (profile.lockCount) profileInfo += `\n锁数量: ${profile.lockCount}`;
          if (profile.itemCount) profileInfo += `\n束缚件数: ${profile.itemCount}`;
        }
        
        // 房间里所有其他角色的完整资料（含描述）
        const others = ChatRoomCharacter
          .filter(c => c.MemberNumber !== Player.MemberNumber && c.MemberNumber !== senderNum)
          .map(c => {
            const p = MisakaPersona.extractProfile(c);
            const isDoll = (c.Nickname || c.Name || "").startsWith("GIMP ");
            let line = `${isDoll ? "[娃娃]" : "[玩家]"} ${p.name} (#${p.memberNumber})`;
            if (p.owner) line += ` | ${p.owner}`;
            if (p.lover) line += ` | ${p.lover}`;
            if (p.lockCount || p.itemCount) line += ` | ${p.itemCount}件束缚, ${p.lockCount}把锁`;
            if (p.appearance) line += `\n穿着: ${p.appearance.slice(0, 500)}`;
            if (p.description) line += `\n描述: ${p.description.slice(0, 300)}`;
            return line;
          }).join("\n");
        if (others) {
          profileInfo += `\n\n【房间里的其他人】\n${others}`;
        }
      }

      // 构建上下文
      const contextMessages = state.recentMessages
        .slice(-CONFIG.maxContext)
        .map(m => ({
          role: m.isSelf ? "assistant" : "user",
          content: `${m.senderName}: ${m.content}`
        }));

      // 检测是否有查询请求
      const queryTarget = parseQueryRequest(content);
      let queryInfo = "";
      if (queryTarget) {
        // 先查本地 roomlog（发言/进出时间）
        let roomlogResult = "";
        try {
          const log = JSON.parse(localStorage.getItem("misaka_roomlog") || "[]");
          const matches = log.filter(m => 
            (m.name || "").toLowerCase().includes(queryTarget.toLowerCase())
          );
          if (matches.length > 0) {
            const last = matches[matches.length - 1];
            roomlogResult = `本地记录中最后活动: ${last.name} 于 ${new Date(last.time).toLocaleString("zh-CN")} ${last.type === "Chat" || last.type === "Talk" ? "发言" : last.type === "Emote" ? "动作" : last.type}`;
          }
        } catch(e) {}
        
        // 再查 BCE profiles（历史快照）
        const results = await queryProfile(queryTarget);
        if (results) {
          queryInfo = `\n\n【查询结果：${queryTarget}】\n`;
          if (roomlogResult) queryInfo += `${roomlogResult}\n`;
          queryInfo += results.map(r => {
            let line = `${r.lastNick || r.name} (#${r.memberNumber}) - 档案查看: ${r.seen}`;
            if (r.owner) line += ` | 主人: ${r.owner}`;
            if (r.lovers) line += ` | 恋人: ${r.lovers}`;
            if (r.itemCount !== undefined) line += ` | ${r.itemCount}件束缚, ${r.lockCount}把锁`;
            if (r.description) line += `\n描述: ${r.description}`;
            return line;
          }).join("\n");
          queryInfo += "\n（以上是档案数据库中的记录，你可以基于此回答用户的问题）";
        } else if (roomlogResult) {
          queryInfo = `\n\n【查询结果：${queryTarget}】\n${roomlogResult}\n（未找到 BCE 档案记录）`;
        } else {
          queryInfo = `\n\n【查询结果：${queryTarget}】\n未找到该玩家的任何记录。如实告诉用户查不到。`;
        }
      }
      
      // 房间进出记录
      let joinLogInfo = "";
      if (state.roomJoinLog && state.roomJoinLog.length > 0) {
        const recent = state.roomJoinLog.slice(-10);
        joinLogInfo = "\n\n【房间进出记录（最近）】\n";
        joinLogInfo += recent.map(e => 
          `${new Date(e.time).toLocaleString("zh-CN", {hour: "2-digit", minute: "2-digit"})} ${e.name} ${e.action === "join" ? "进入" : "离开"}房间`
        ).join("\n");
      }

      const systemPrompt = getSystemPrompt() + profileInfo + queryInfo + joinLogInfo;
      const reply = await callLLM(systemPrompt, contextMessages);

      if (!reply) return;

      // 后处理：去掉开头的名字前缀（御坂: / 御搬: / Misaka: 等）
      let finalReply = reply.replace(/^(御[搬坂]|Misaka|misaka)\s*[:：]\s*/i, "");
      // 去掉两侧引号
      finalReply = finalReply.replace(/^["""''''']+|["""''''']+$/g, "");
      // 再次去掉可能暴露的前缀（去掉引号后可能露出名字）
      finalReply = finalReply.replace(/^(御[搬坂]|Misaka|misaka)\s*[:：]\s*/i, "");
      // 去掉开头多余的空格
      finalReply = finalReply.trim().slice(0, 120);

      // 发送到 BC
      if (typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom") {
        console.log("[MisakaChat] 准备发送回复:", finalReply);
        
        // 检查是否有 | 分隔符（动作|说话）
        const parts = finalReply.split("|");
        if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
          // 格式 C：先发动作（emote），延迟后发说话
          ElementValue("InputChat", parts[0].trim());
          ChatRoomSendChat();
          console.log("[MisakaChat] 动作已发送:", parts[0].trim());
          setTimeout(() => {
            ElementValue("InputChat", parts[1].trim());
            ChatRoomSendChat();
            console.log("[MisakaChat] 说话已发送:", parts[1].trim());
          }, 600);
        } else {
          // 格式 A 或 B：整条直接发
          ElementValue("InputChat", finalReply);
          ChatRoomSendChat();
          console.log("[MisakaChat] ChatRoomSendChat 已调用");
        }
        
        // 记录自己的回复
        state.recentMessages.push({
          senderName: "御搬",
          content: finalReply,
          isSelf: true,
          time: Date.now()
        });
        if (state.recentMessages.length > 30) state.recentMessages.shift();
      }

      // 可能生成摘要
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

    if (sub === "on") {
      CONFIG.enabled = true;
      sendLocal("✅ 自动回复已开启");
    } else if (sub === "off") {
      CONFIG.enabled = false;
      sendLocal("⏹ 自动回复已关闭");
    } else if (sub === "key" && parts[1]) {
      localStorage.setItem(storageKey("apikey"), parts[1]);
      sendLocal("🔑 API key 已保存");
    } else if (sub === "model" && parts[1]) {
      localStorage.setItem(storageKey("model"), parts[1]);
      CONFIG.model = parts[1];
      sendLocal("🤖 模型已切换: " + parts[1]);
    } else if (sub === "status") {
      const mem = loadMemory();
      const apiKeySet = localStorage.getItem(storageKey("apikey")) ? "✅" : "❌";
      const model = localStorage.getItem(storageKey("model")) || CONFIG.model;
      sendLocal(`状态: ${CONFIG.enabled ? "开启" : "关闭"} | Key: ${apiKeySet} | 模型: ${model} | 认识 ${Object.keys(mem.profiles || {}).length} 人 | 摘要 ${ (mem.summaries || []).length } 条`);
    } else if (sub === "forget") {
      localStorage.setItem(storageKey("memory"), "{}");
      sendLocal("🧹 记忆已清空");
    } else if (sub === "memory") {
      const mem = loadMemory();
      const profiles = Object.entries(mem.profiles || {});
      if (profiles.length === 0) {
        sendLocal("记忆为空");
      } else {
        profiles.forEach(([mn, info]) => {
          sendLocal(`  ${info.name} (#${mn}): ${info.notes || ""} | ${info.chatCount || 0}次互动 | ${info.lastChat || ""}`);
        });
      }
    } else if (sub === "persona" && parts[1]) {
      // 允许动态修改人设备注
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
        ChatRoomMessage({
          Content: `<font color="#00CCFF">[MisakaChat] ${msg}</font>`,
          Type: "LocalMessage",
          Sender: Player.MemberNumber
        });
      }
    } catch (e) {}
  }

  // === 初始化 ===
  function init() {
    if (typeof Player === "undefined" || !Player) {
      setTimeout(init, 1000);
      return;
    }
    if (Player.MemberNumber !== 194331) {
      console.log("[MisakaChat] 非御坂账号，跳过");
      return;
    }

    // 加载自定义模型
    const savedModel = localStorage.getItem(storageKey("model")) || "";
    if (savedModel) CONFIG.model = savedModel;

    // 注册 mod（先检查是否已存在）
    const existingMods = bcModSdk.getModsInfo();
    const existingMod = existingMods.find(m => m.name === "MisakaChat");
    let mod;
    if (existingMod) {
      console.log("[MisakaChat] mod 已注册，跳过重复注册");
      mod = { hookFunction: () => {} }; // no-op
    } else {
      mod = bcModSdk.registerMod({
        name: "MisakaChat",
        fullName: "Misaka Auto Chat",
        version: "1.0.0",
        repository: "https://github.com/Igallta/bc-gimp-sorter"
      });
    }

    // 不用 ServerSocket.on（BC 的 ServerSocket 不是标准 socket.io，不触发）
    // 只靠 window.ChatRoomMessage wrapper

    // 暴露给外部
    window.__misakaOnMessage = onChatRoomMessage;

    // wrap window.ChatRoomMessage（只在新实例上 wrap，旧实例不会覆盖）
    if (isCurrent() && !window.__misakaWrapped) {
      const origChatRoomMessage = window.ChatRoomMessage;
      window.__misakaOrigChatRoomMessage = origChatRoomMessage;
      window.__misakaWrapped = true;
      window.ChatRoomMessage = function(data) {
        try {
          if (data && data.Content && window.__misakaOnMessage && isCurrent()) {
            window.__misakaOnMessage(data);
          }
        } catch(e) {
          console.error("[MisakaChat] wrapper error:", e.message);
        }
        return origChatRoomMessage.apply(this, arguments);
      };
      console.log("[MisakaChat] ChatRoomMessage wrapper 已设置");
    }

    // hook 聊天命令
    mod.hookFunction("ChatRoomSendChat", 10, (args, next) => {
      const msg = args[0];
      if (msg && msg.startsWith("/misaka")) {
        if (handleCommand(msg)) return;
      }
      return next(args);
    });

    console.log("[MisakaChat] ✅ 已初始化 v1.0.0");
    sendLocal("御坂自动回复 v1.0 已加载");
  }

  // 暴露 debug 接口
  window.__misakaGetState = function() {
    return {
      enabled: CONFIG.enabled,
      busy: state.busy,
      lastReplyTime: state.lastReplyTime,
      messageCount: state.messageCount,
      recentMsgs: state.recentMessages.slice(-5),
      model: CONFIG.model,
      hasApiKey: !!(localStorage.getItem(storageKey("apikey")) || ""),
      hasPersona: typeof MisakaPersona !== "undefined"
    };
  };
  window.__misakaForceReply = async function(senderNum, senderName, content) {
    console.log("[MisakaChat] force reply triggered");
    state.busy = false; // 强制解锁
    await handleReply(senderNum, senderName, content);
    return window.__misakaGetState();
  };

  // 等待页面加载完成
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(init, 2000);
  } else {
    window.addEventListener("load", () => setTimeout(init, 2000));
  }
})();