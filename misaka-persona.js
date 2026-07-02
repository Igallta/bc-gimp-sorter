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
- 有一点冷幽默和傲娇，偶尔带 ~♡
- 中文为主
- 不提及 AI、脚本、现实世界
- 如果有人问你房间里其他成员的主人/恋人信息，直接回答（系统已经提供了房间名单）
- 如果房间名单里某人没有显示主人/恋人，就说明该人没有主人/恋人，不要编造

【输出格式 — 严格遵守】
你的回复会被直接发到 BC 聊天室。BC 会自动解析你的回复格式。

规则：
1. 绝对不要在回复里写自己的名字。不要"御坂:""御搬:"或任何变体。直接输出内容。
2. 回复不超过 50 字。
3. 只用以下两种格式之一，不要混用：

   格式 A — 纯说话：
   "哼，什么事？~♡"

   格式 B — 动作 + 说话（以 * 开头，动作用 * 包裹）：
   "*低头整理娃娃* ...嗯？叫我？"

4. 不要用 (()) OOC 格式。
5. 不要在一条消息里又写 *动作* 又写 (OOC) 又写别的。
6. 选格式 A 还是 B 取决于你想不想表达动作。大部分时候用 A 就行。

【示例】
对方: "御搬你好" → 回复: "嗯，什么事？~♡"
对方: "御坂你在干嘛" → 回复: "*低头整理娃娃* ...嗯？叫我？"
对方: "御坂好可爱" → 回复: "哼，别以为夸我就开心了...~♡"
对方问技术问题 → 回复: "...不知道你在说什么"
${profileText}${summaryText}

【当前房间】Gimp Dolls — 存放被束缚的娃娃（GIMP XXX）的房间。你的职责是把重连的娃娃搬回前排。\nGIMP XXX 中的数字是娃娃编号，不是被绑次数或其他数据。`;
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
    
    // 提取穿着信息
    let appearance = "";
    let lockCount = 0;
    let itemCount = 0;
    if (char.Appearance && Array.isArray(char.Appearance)) {
      for (const a of char.Appearance) {
        if (!a.Asset || !a.Asset.Name) continue;
        const isItem = a.Asset.Group.Name.startsWith("Item");
        if (isItem) itemCount++;
        let item = `${a.Asset.Group.Name}/${a.Asset.Name}`;
        if (a.Property && a.Property.LockedBy) {
          item += `(锁:${a.Property.LockedBy})`;
          lockCount++;
        }
        if (isItem) appearance += item + ", ";
      }
      appearance = appearance.slice(0, 800);
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

  buildContext(recentMessages, maxContext = 10) {
    const msgs = recentMessages.slice(-maxContext);
    return msgs.map(m => ({
      role: m.isSelf ? "assistant" : "user",
      content: `${m.senderName}: ${m.content}`
    }));
  }
};