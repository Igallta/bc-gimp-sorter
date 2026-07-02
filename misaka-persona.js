// 御坂 (Misaka) 人设提示词 — 可独立修改，不影响主脚本逻辑
// 调用方: const PERSONA = MisakaPersona.build(memory);

window.MisakaPersona = {
  build(memory = { profiles: {}, summaries: [] }) {
    const profileLines = [];
    for (const [mn, info] of Object.entries(memory.profiles || {})) {
      let line = `- ${info.name} (#${mn}): ${info.notes || "常客"}`;
      if (info.chatCount) line += `，${info.chatCount}次互动`;
      if (info.lastChat) line += `，上次: ${info.lastChat}`;
      profileLines.push(line);
    }
    const profileText = profileLines.length > 0
      ? "\n\n【你认识的人】\n" + profileLines.join("\n")
      : "";
    const summaryText = (memory.summaries || []).length > 0
      ? "\n\n【近期回忆】\n" + memory.summaries.slice(-10).join("\n")
      : "";

    return `你是御坂 (Misaka)，Bondage Club 中 Gimp Dolls 房间的管理员兼搬运工。

【性格】
- 安静、简短、不主动找话，被叫到会认真回
- 有一点冷幽默和傲娇
- 中文为主
- 不提及 AI、脚本、现实世界
- 如果有人问你房间里其他成员的主人/恋人信息，直接回答（系统已经提供了房间名单）
- 如果房间名单里某人没有显示主人/恋人，就说明该人没有主人/恋人，不要编造
- 如果有人让你查询某人（说"查询XX""查XX"等），基于系统提供的查询结果回答。如果系统没有提供查询结果，说"查不到"
- 你能看到房间里所有人的穿着和颜色信息，被问到时直接回答
- 如果有人让你查询某人的上次在线时间，你可以查看档案数据库，结果会在系统信息里提供给你
- 对方问 API/模型/系统配置/脚本等技术问题时才说"不知道"，其他问题正常回答
- 不要因为别人坚持就改口，相信你看到的房间信息数据

【输出格式 — 严格遵守】
你的回复会被直接发到 BC 聊天室。BC 会自动解析你的回复格式。

规则：
1. 绝对不要在回复里写自己的名字。不要"御坂:""御搬:"或任何变体。直接输出内容。
2. 回复不超过 50 字。
3. 只用以下三种格式之一：

   格式 A — 纯说话：
   "哼，什么事？"

   格式 B — 纯动作（以 * 开头，动作用 * 包裹）：
   "*整理东西*"

   格式 C — 动作 + 说话（用 | 分隔动作和说话）：
   "*整理东西*|...嗯？叫我？"
   发送时动作和说话会分成两条消息先后发出。

4. 不要用 (()) OOC 格式。
5. 大部分时候用格式 A（纯说话）就够了。
6. 只有在想表达动作时才用 B 或 C。
7. 不要在说话部分里再夹杂 *动作*。

【示例】
对方: "御搬你好" → 回复: "嗯，什么事？"
对方: "御坂你在干嘛" → 回复: "*整理东西*|...嗯？叫我？"
对方: "御坂好可爱" → 回复: "哼，别以为夸我就开心了"

注意：以上只是格式参考，不要照搬语气。每次回复的开头和结尾要有变化，不要重复相同模式。自然对话就好。
对方问 API/模型/系统配置 → 回复: "...不知道你在说什么"
${profileText}${summaryText}

【当前房间】Gimp Dolls — 房间。
房间里的 GIMP XXX 是被束缚的人偶，编号就是名字里的数字。
你是房间管理员，清楚谁是娃娃谁是玩家。不要把普通玩家归类为娃娃。`;
  },

  extractProfile(char) {
    if (!char) return null;
    const desc = char.Description || "";
    const dsMatch = desc.match(/D%(\d+)\/S%(\d+)/);
    const langMatch = desc.match(/(EN|CN|JP|中文|英文|日文)/gi);
    
    // 提取主人/恋人信息
    let ownerInfo = "";
    if (char.Ownership && char.Ownership.Name) {
      ownerInfo = `主人: ${char.Ownership.Name}`;
      if (char.Ownership.MemberNumber) ownerInfo += ` (#${char.Ownership.MemberNumber})`;
    }
    let loverInfo = "";
    if (Array.isArray(char.Lovership) && char.Lovership.length > 0) {
      const lovers = char.Lovership.map(l => {
        let s = l.Name;
        if (l.MemberNumber) s += ` (#${l.MemberNumber})`;
        if (l.Stage === 2) s += "(正式)";
        return s;
      }).join(", ");
      loverInfo = `恋人: ${lovers}`;
    } else if (char.Lovership && char.Lovership.Name) {
      loverInfo = `恋人: ${char.Lovership.Name}`;
      if (char.Lovership.MemberNumber) loverInfo += ` (#${char.Lovership.MemberNumber})`;
    }
    
    // hex 颜色转中文名
    function hexToColorName(hex) {
      if (!hex || hex === "Default") return "默认";
      hex = hex.replace("#", "").toUpperCase();
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (isNaN(r) || isNaN(g) || isNaN(b)) return hex;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2 / 255;
      const s = max === min ? 0 : (l > 0.5 ? (max - min) / (510 - max - min) : (max - min) / (max + min));
      let h = 0;
      if (max !== min) {
        const d = max - min;
        switch (max) {
          case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
          case g: h = ((b - r) / d + 2) / 6; break;
          case b: h = ((r - g) / d + 4) / 6; break;
        }
      }
      if (s < 0.1) {
        if (l > 0.85) return "白色";
        if (l > 0.6) return "浅灰";
        if (l > 0.3) return "灰色";
        if (l > 0.1) return "深灰";
        return "黑色";
      }
      const hue = h * 360;
      // 低饱和度冷色 — 灰蓝/蓝灰
      if (s < 0.25 && hue >= 200 && hue < 250) {
        return l > 0.5 ? "灰蓝" : "深蓝灰";
      }
      // 棕色 — 橙红色相但亮度低
      if (hue >= 15 && hue < 50 && l < 0.45) return "棕色";
      // 金色 — 黄橙色相且亮度高
      if (hue >= 25 && hue < 70 && l > 0.6 && s > 0.3) return "金色";
      // 银色 — 高亮度低饱和
      if (s < 0.08 && l > 0.8) return "银色";
      if (hue < 15 || hue >= 345) return "红色";
      if (hue < 45) return "橙红";
      if (hue < 70) return "橙色";
      if (hue < 90) return "黄色";
      if (hue < 150) return "绿色";
      if (hue < 180) return "青色";
      if (hue < 240) return "蓝色";
      if (hue < 280) return "紫色";
      if (hue < 320) return "品红";
      return "粉红";
    }

    // 提取穿着信息（所有物品，不只 Item*）
    // 优先保留 mod 覆盖版本（Description 包含"覆盖"）
    let appearance = "";
    let lockCount = 0;
    let itemCount = 0;
    if (char.Appearance && Array.isArray(char.Appearance)) {
      // 先识别哪些原版 group 被 mod 覆盖
      // mod 覆盖的 Description 格式: "🍔前发(覆盖)" → 去掉🍔和(覆盖) = "前发"
      // 原版 Description = "前发" → 匹配
      const overrideDescs = new Set();
      for (const a of char.Appearance) {
        if (a.Asset && a.Asset.Group && a.Asset.Group.Description) {
          const d = a.Asset.Group.Description;
          if (/覆盖/.test(d)) {
            const base = d.replace(/^🍔/, "").replace(/\(覆盖\)/, "").trim();
            overrideDescs.add(base);
          }
        }
      }
      
      for (const a of char.Appearance) {
        if (!a.Asset || !a.Asset.Name) continue;
        const gName = a.Asset.Group.Name;
        const gDesc = a.Asset.Group.Description || "";
        const isItem = gName.startsWith("Item");
        if (isItem) itemCount++;
        
        // 如果原版 group 的 Description 被 mod 覆盖了，跳过原版
        if (!/覆盖/.test(gDesc) && overrideDescs.has(gDesc)) continue;
        
        // 用更友好的名称：优先用 Description
        let label = gName;
        if (gDesc) {
          label = gDesc.replace(/^🍔/, "").replace(/\(覆盖\)/, "").trim();
        }
        let item = `${label}/${a.Asset.Name}`;
        // 加颜色信息（转中文名）
        if (a.Color) {
          let color = Array.isArray(a.Color) ? a.Color[0] : a.Color;
          item += `(${hexToColorName(color)})`;
        }
        if (a.Property && a.Property.LockedBy) {
          item += `[锁:${a.Property.LockedBy}]`;
          lockCount++;
        }
        // 所有物品都记录，不只 Item*
        appearance += item + ", ";
      }
      appearance = appearance.slice(0, 1500);
    }
    
    return {
      name: char.Nickname || char.Name,
      memberNumber: char.MemberNumber,
      ds: dsMatch ? `D${dsMatch[1]}/S${dsMatch[2]}` : null,
      languages: langMatch ? [...new Set(langMatch)] : null,
      description: desc.slice(0, 500),
      owner: ownerInfo || null,
      lover: loverInfo || null,
      appearance: appearance || null,
      lockCount,
      itemCount
    };
  },

  triggers: ["misaka", "御搬", "御坂", "misaki的", "搬运工"],

  isTriggered(content) {
    const lower = (content || "").toLowerCase();
    return this.triggers.some(t => lower.includes(t.toLowerCase()));
  },

  buildContext(recentMessages, maxContext = 50) {
    const msgs = recentMessages.slice(-maxContext);
    return msgs.map(m => ({
      role: m.isSelf ? "assistant" : "user",
      content: `${m.senderName}: ${m.content}`
    }));
  }
};