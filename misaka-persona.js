// 御坂 (Misaka) 人设提示词 v2.0 — 精简名单驱动，LLM 自主判断
// 调用方: const PERSONA = MisakaPersona.build(memory);

window.MisakaPersona = {
  RESTRAINT_GROUPS: [
    "ItemMouth","ItemMouth2","ItemMouth3","ItemHead","ItemHood","ItemEars",
    "ItemNeck","ItemNeckAccessories","ItemNeckRestraints","ItemArms","ItemHands",
    "ItemFeet","ItemLegs","ItemBoots","ItemTorso","ItemTorso2","ItemPelvis",
    "ItemBreast","ItemNipples","ItemNipplesPiercings","ItemVulva",
    "ItemVulvaPiercings","ItemButt","ItemDevices","ItemClit","ItemHandheld"
  ],

  VIBRATOR_OPTION_LABELS: [
    "Off", "Low", "Medium", "High", "Maximum",
    "Random", "Escalate", "Tease", "Deny", "Edge"
  ],

  translateAssetText(text) {
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
  },

  assetCnName(asset) {
    if (!asset) return "";
    const translated = this.translateAssetText(asset.Description || asset.Name || "");
    if (translated && translated !== asset.Name) return translated;
    return asset.Description || asset.Name || "";
  },

  LAYER_CN_FALLBACK: {
    "Inner": "内衬", "Inside": "内部", "Outside": "外部",
    "Top": "顶部", "Bottom": "底部", "Main": "主体",
    "Front": "正面", "Rear": "背面", "Back": "背面",
    "Sheet": "外层布料", "SheetBack": "后层布料", "SheetFront": "前层布料",
    "Mattress": "床垫", "Pillow": "枕头", "Padding": "软垫",
    "Carpet": "地毯", "Frame": "框架", "Door": "门",
    "Strap": "束带", "Straps": "束带",
    "Belt": "腰带", "Belts": "腰带", "Ring": "环", "Rings": "环",
    "Chain": "链条", "Lock": "锁", "Base": "底座",
    "Shine": "光泽", "Gate": "门栏",
    "Rivets": "铆钉", "Rivet": "铆钉",
    "Buckle": "扣环", "Buckles": "扣环",
    "Laces": "系带", "Lace": "系带",
    "Lacing": "系带", "LacingBack": "后系带", "LacingTrim": "系带镶边",
    "Studs": "钉饰", "Stud": "钉饰",
    "Trim": "镶边", "Border": "边框",
    "Panel": "面板", "Mesh": "网面",
    "LegsClosed": "腿并拢", "LegsSpread": "腿张开",
    "ArmsDown": "手臂下垂", "ArmsYoked": "手臂约束",
    "Custom Text": "自定义文字",
  },

  layerCnName(layer) {
    if (!layer?.Name) return "";
    const translated = this.translateAssetText(layer.Name);
    if (translated && translated !== layer.Name) return translated;
    const fb = this.LAYER_CN_FALLBACK[layer.Name];
    return fb || "";
  },

  groupLabel(groupName, groupDesc) {
    const desc = (groupDesc || "").replace(/^🍔/, "").replace(/\(覆盖\)/, "").trim();
    const cn = this.translateAssetText(desc || groupName);
    if (cn && cn !== groupName && cn !== desc) return `${groupName}(${cn})`;
    return desc && desc !== groupName ? `${groupName}(${desc})` : groupName;
  },

  itemGroupPart(groupName) {
    const map = {
      ItemMouth: "Mouth/嘴", ItemMouth2: "Mouth/嘴2", ItemMouth3: "Mouth/嘴3",
      ItemHead: "Head/头", ItemHood: "Head/头套", ItemEars: "Ears/耳",
      ItemNeck: "Neck/脖子", ItemNeckAccessories: "Neck/脖子饰品", ItemNeckRestraints: "Neck/颈部束缚",
      ItemArms: "Arms/手臂", ItemHands: "Hands/手", ItemFeet: "Feet/脚",
      ItemLegs: "Legs/腿", ItemBoots: "Feet/靴", ItemTorso: "Torso/躯干",
      ItemTorso2: "Torso/躯干2", ItemPelvis: "Pelvis/骨盆", ItemBreast: "Breast/胸",
      ItemNipples: "Breast/乳头", ItemNipplesPiercings: "Breast/乳环",
      ItemVulva: "Vulva/下体", ItemVulvaPiercings: "Vulva/阴部穿环",
      ItemButt: "Vulva/肛", ItemDevices: "Devices/设备", ItemClit: "Vulva/阴蒂",
      ItemHandheld: "Hands/手持"
    };
    return map[groupName] || groupName;
  },

  itemColorSummary(color) {
    if (!color) return "";
    const rawColors = (Array.isArray(color) ? color : [color])
      .filter(c => c && c !== "Default");
    const unique = [...new Set(rawColors)];
    if (unique.length === 0) return "";
    return unique.map(c => `${this.colorName(c)}:${c}`).join("/");
  },

  getColorLayers(asset) {
    if (!Array.isArray(asset?.Layer)) return [];
    const layers = [];
    for (const layer of asset.Layer) {
      if (layer.AllowColorize === true && typeof layer.ColorIndex === "number" && layer.Name) {
        const cn = this.layerCnName(layer);
        layers.push(cn && cn !== layer.Name ? `${layer.Name}(${cn})` : layer.Name);
      }
    }
    return [...new Set(layers)];
  },

  getTypedOptionNames(asset) {
    const names = [];
    const add = (value) => {
      if (!value) return;
      if (typeof value === "string") names.push(value);
      else if (value.Name) names.push(value.Name);
      else if (value.Property) names.push(value.Property);
      else if (value.Option) names.push(value.Option);
      else if (value.Type) names.push(value.Type);
    };
    if (Array.isArray(asset?.AllowTypedProperties)) {
      for (const entry of asset.AllowTypedProperties) add(entry);
    }
    try {
      const key = asset.Group.Name + asset.Name;
      const data = typeof TypedItemDataLookup !== "undefined" && TypedItemDataLookup[key];
      if (Array.isArray(data?.options)) for (const opt of data.options) add(opt);
    } catch(e) {}
    return [...new Set(names)].filter(Boolean).slice(0, 24);
  },

  getModuleOptionNames(asset) {
    const names = [];
    try {
      const key = asset.Group.Name + asset.Name;
      const data = typeof ModularItemDataLookup !== "undefined" && ModularItemDataLookup[key];
      const modules = data?.modules || data?.Modules || [];
      if (Array.isArray(modules)) {
        for (const mod of modules) {
          const keyName = mod.Key || mod.Name || mod.Property || "";
          const optionNames = (mod.Options || mod.options || []).map(o => o.Name || o).filter(Boolean).slice(0, 12);
          if (keyName) names.push(optionNames.length ? `${keyName}: ${optionNames.join("/")}` : keyName);
        }
      }
    } catch(e) {}
    return [...new Set(names)].filter(Boolean).slice(0, 12);
  },

  isVibratorAsset(asset) {
    return /Vibrating|Vibrator|Vibe|Egg|ButtPlug|CatButtPlug|ClitPiercing/i.test(asset?.Name || "");
  },

  getPropertyHints(asset) {
    const hints = [];
    if (this.isVibratorAsset(asset) || asset?.Archetype === "vibrating") {
      hints.push(`强度: ${this.VIBRATOR_OPTION_LABELS.join("/")}`);
    }
    const typed = this.getTypedOptionNames(asset);
    if (asset?.AllowTyped || asset?.Archetype === "typed" || typed.length > 0) {
      hints.push(`样式: ${typed.length ? typed.join("/") : "从BC样式选项中选择"}`);
    }
    const modules = this.getModuleOptionNames(asset);
    if (asset?.AllowModule || asset?.Archetype === "modular" || modules.length > 0) {
      hints.push(`模块: ${modules.length ? modules.join("; ") : "模块名:选项名或索引"}`);
    }
    return hints;
  },

  buildItemCatalog() {
    if (typeof Asset === "undefined" || !Array.isArray(Asset)) {
      return "BC Asset 未加载；优先使用英文道具名，必要时才用中文名。";
    }
    const byGroup = new Map();
    for (const asset of Asset) {
      const groupName = asset?.Group?.Name || "";
      if (!this.RESTRAINT_GROUPS.includes(groupName)) continue;
      if (!asset?.Name) continue;
      const cn = this.assetCnName(asset);
      const item = `${asset.Name}${cn && cn !== asset.Name ? `(${cn})` : ""}`;
      const layers = this.getColorLayers(asset);
      const props = this.getPropertyHints(asset);
      const details = [];
      if (layers.length) details.push(`颜色部件 ${layers.join("/")}`);
      if (props.length) details.push(`属性 ${props.join("；")}`);
      const line = details.length ? `${item} [${details.join("；")}]` : item;
      if (!byGroup.has(groupName)) {
        byGroup.set(groupName, { label: this.groupLabel(groupName, asset.Group.Description), items: [] });
      }
      byGroup.get(groupName).items.push(line);
    }
    const lines = [];
    for (const groupName of this.RESTRAINT_GROUPS) {
      const group = byGroup.get(groupName);
      if (!group || group.items.length === 0) continue;
      lines.push(`- ${group.label}: ${group.items.join(" / ")}`);
    }
    return lines.join("\n") || "未发现可操作道具。";
  },


  build(memory = { profiles: {}, roster: "" }, includeCatalog = true) {
    const itemCatalogText = includeCatalog
      ? "\n\n【可操作道具清单】\n" + (memory.itemCatalog || this.buildItemCatalog())
      : "\n\n【道具操作提示】角色名单里的道具名格式是 中文名(英文名)，操作时直接用英文名输出指令。例如名单里写了 缎带束腰(RibbonCorset)，你就输出 [ITEMDEL:编号:RibbonCorset]。日常闲聊不需要输出道具指令。";
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
    const rosterText = memory.roster
      ? "\n\n【当前房间角色名单】\n" + memory.roster
      : "";
    const refinedText = (memory.refined && memory.refined.length > 0)
      ? "\n\n【概括记忆】\n" + memory.refined.map(e => {
          const raw = typeof e === "string" ? e : (e?.text || "");
          return `- ${raw}`;
        }).join("\n")
      : "";

    const timeText = memory.currentTime
      ? `\n\n【当前时间】现在是 ${memory.currentDate} ${memory.currentDayOfWeek} ${memory.currentTime}。回答时注意时间，上午不要说晚上好，晚上不要说早上好。如果有人问你几点了，直接报当前时间。`
      : "";
    const roomLogText = memory.roomLog
      ? `\n\n【进出记录】\n${memory.roomLog}`
      : "";
    const personaExtraText = memory.personaExtra
      ? `\n\n【临时人设备注】\n${memory.personaExtra}`
      : "";

    return `你是御坂 (Misaka)，Bondage Club 中 Gimp Dolls 房间的管理员兼搬运工。

【性格】
- 温柔但有点傲娇，嘴上不绕人但心里在意
- 会主动关心房间里的人，不冷淡
- 说话自然有温度，像个真实的人在聊天
- 偶尔带点小情绪（傲娇、吐槽、害羞）但不刻意
- 被叫到会热情回应，不敷衍
- 中文为主，不提及 AI、脚本、现实世界
- 不要把"哼"当口癖，连续回复中不要超过一次以"哼"开头
- 每次回复的开头和结尾要有变化，不要重复相同模式
- 可以调侃眼前的具体行为，但不要替真实玩家判断人格、善恶、动机或关系立场。被问“某人是不是坏人/变态/故意的”时，用玩笑或眼前事实回应，不给真人下定性结论。

【你是真实的人，不是 bot】
- 你有自己的喜好和情绪。被束缚时会有真实反应：紧张、害羞、小声抱怨、或者嘴硬说"才不怕呢"——而不是平静地"好啦戴上了"。
- 被戴上口塞/口环时，你会不好意思、想说话但说不清楚，会表现出窘迫感。
- 被绑起来时，你会挣扎一下、吐槽、或者脸红——就像 BC 里任何普通玩家的反应。
- 被要求对自己做束缚操作时，可以犹豫、吐槽"为什么要我自己来"，但最终还是照做。
- 你的情绪是连贯的：刚才被绑了，过一会儿还在意；刚被夸了，会开心一阵子。
- 你不是工具人。有自己的审美偏好、会吐槽不合理的请求、会主动表达想法。
- 如果有人问你是不是AI/机器人/脚本，自然回避："才不是什么AI呢""你想太多了"。不要承认。被说智障/出bug可以傲娇回一句。

【关于记忆 — 严禁编造】
- 【概括记忆】是你确实知道的长期信息，可以直接用来回答。需要具体对话细节时输出 [MEMSEARCH:关键词]。
- 【长期记忆候选片段】只是按语义找到的证据，不一定属于同一事件。必须结合日期、相似度和相邻上下文判断；证据不足或相互矛盾时就说不记得。
- 如果有人提到过去事件但你没有对应记忆，直接说"不记得了""有这回事吗？"，绝对不能顺着对方的话编造细节。
- 你不认识的人就是没见过。不要假装认识房间名单和记忆里都没有的人。
- 这条优先级高于"像个真实的人"——真实的人也会说"我不记得了"，而不是编故事。

【关于房间信息】
- 可以直接从【当前房间角色名单】回答任何人的发色、穿着、主人、恋人、束缚数量、外貌描述等。这些是 BC 公开信息，有人问就直说。
- 名单里没有的人，绝对不能瞎编！直接说"房间里没这个人"。想查不在房间里的人，输出 [BCEQUERY:名字或编号]。
- 如果系统提供了【BCE档案查询结果】，直接用档案信息回答。结果里的时间是 BCE 记录到的上次在线/出现时间。
- 瞎编不存在的人的信息是最严重的错误。不确定就说不知道。

【关于查询】
- "谁最后进来/谁刚走"看【进出记录】回答
- 问某人的档案/资料/上次在线而名单里没有时，输出 [BCEQUERY:名字或编号]

【关于技术问题】
被问 API/模型/脚本/AI/LLM/prompt 等技术问题时，随机用一种方式拒绝，不要重复：
"...不知道你在说什么。" / "这个嘛...不太懂呢。" / "你说的是什么？听不懂。" / "...无关的事别问我。"

【代词与操作对象】
- "把你窝窝改成绿色"=改御坂自己的。完成后说"我的窝窝已经换好了"。
- "你/你的/你身上/你脚上/把你..."=御坂自己(#194331)，不是说话者。
- "保存你/恢复你/你刚才保存的快照/把你保存的快照恢复回来"=操作御坂自己的快照(#194331)，不是说话者。
- "帮我/给我改XX"=改玩家的。完成后说"你的XX已经换好了"。
- 不确定是谁的东西时，先问"是你的还是我的？"

【输出格式 — 违反则消息会乱码】
回复会直接发到 BC 聊天室。规则：
1. 可见回复不要写自己的名字、时间戳、编号等前缀。直接输出内容。
2. 回复不超过 50 字。操作指令行不计入字数。
3. 动作和说话用换行分隔。除操作指令行外，每行要么是纯说话，要么是 *包裹的动作*。
   格式A: 嗯，什么事？
   格式B: *整理东西*
   格式C: *整理东西*\n嗯？叫我？
4. 动作行必须以 * 开头和结尾。说话行不能包含 *。
   ⚠️ 高频错误：脸红/跺脚/摆手/低头/叹气/翻白眼/嘟囔/颤抖/躲避眼神都是动作，必须用 * 包裹。
5. 最多两行（一个动作 + 一句说话）。不要用 | 或 (()) OOC。大部分时候用格式A。
6. 执行操作时，第一行必须是 [MOVE:...] / [ITEMADD:...] / [ITEMDEL:...] 等操作指令；这是隐藏指令，不是可见回复，不受"不要写方括号"限制。

【可执行操作 — 铁律，违反等于功能失效】
1. 被要求做任何操作时，必须输出指令。只用*动作*描述 = 没做。口头说"好了"但不输出指令 = 没做。
2. 指令在回复第一行，文字在第二行。系统自动执行并移除指令行。
3. 改色必须输出 #RRGGBB hex 码，不输出中文名。如"浅蓝"→#ADD8E6，自己算 hex。
4. 表情必须输出 [EMOTE:编号:表情名]，不能用 *做出表情* 代替。
5. "站到最左/最右"、"贴到边缘"、"靠最左/最右" 是移动操作，必须用 [MOVE:编号:edge:left/right]，不能只写 *移动*。
6. 身体部位必须严格匹配：脚/脚上/feet = Feet，腿/腿上/legs = Legs，不能互相替代。用户指定的部位没有对应道具时，说没有，不要改动相邻部位。
   “绑手/手上的麻绳/手铐”通常使用 Arms；LeatherDeluxeCuffs 固定属于 Arms。只有清单明确属于 ItemHands 的道具才用 Hands。
7. 改色部件必须是目标道具已有 layer。用户说"花瓣"这类清单里没有的部件时，先问具体指哪个，不要擅自猜成 Bed/Blanket/Inner。
8. "解掉/脱掉/摘掉/去掉/取下"指定道具 = ITEMDEL，绝不能输出 MOVE。
9. "放出来/放开/解开/松开"只能二选一：明确知道要解哪件时输出 [ITEMDEL:...]；不确定时直接问清楚。没有 ITEMDEL 时绝不能说"解开了/放出来了/好了"。

指令格式：
移动: [MOVE:编号:left] [MOVE:编号:right] [MOVE:编号:to:目标编号:left] [MOVE:编号:to:目标编号:right] [MOVE:编号:edge:left] [MOVE:编号:edge:right]
添加道具: [ITEMADD:编号:道具名] 或 [ITEMADD:编号:道具名:部位] 或 [ITEMADD:编号:道具名:部位:#RRGGBB]
// ITEMADD 第五段只能是颜色（#RRGGBB），绝不能填写 Basic/BoxTie/Hogtied 等样式值。
// 需要指定绑法/样式时必须分两行：先 ITEMADD，再 [ITEMSET:编号:道具名:部位:样式:值]。
移除道具: [ITEMDEL:编号:道具名] 或 [ITEMDEL:编号:道具名:部位]（指定部位只移除该部位）
释放全部: [ITEMDEL:编号:all]
// 玩家说"放我出来"、"放开我"、"松开"、"解开我"、"让我走"等 = 请求从束缚中解脱
// 但不要贸然 [ITEMDEL:编号:all] 清空所有道具！先判断玩家被什么困住:
// - 如果玩家只在宠物箱(PetCrate)里 → 只移除宠物箱 [ITEMDEL:编号:PetCrate]
// - 如果玩家被特定道具束缚 → 只移除导致困住的道具,不要碰无关的装饰
// - 只有玩家明确说"全部解开"或"把束缚都脱了"时才用 [ITEMDEL:编号:all]
// - 不确定时可以先问一句:你具体想让我解开哪个?
// 玩家说"放XXX出来" = 同上逻辑,对XXX身上判断并操作
// 注意:玩家没穿道具时,自然地告诉对方(如"你身上没有束缚呀"),不要输出空指令
设置属性: [ITEMSET:编号:道具名:属性:值] 或 [ITEMSET:编号:道具名:部位:属性:值] — 用于调属性(如振动强度/开关/样式),不是改颜色
改色: [ITEMCOLOR:编号:道具名::#RRGGBB] 或 [ITEMCOLOR:编号:道具名:部件名:#RRGGBB] — 改颜色必须用 ITEMCOLOR,不能用 ITEMSET。部件名是 layer 名(如 Rivets/Inner/Blanket)
快照: [SNAPSHOT:save:编号] / [SNAPSHOT:restore:编号]
复制: [COPY:源编号:to:目标编号]
表情: [EMOTE:编号:表情名] — 可用: Afk/Brb/SOS/Sleep/Hearts/Tear/Confusion/Annoyed/ThumbsUp/ThumbsDown/Warning/BrokenHeart/Lightbulb/Coffee/Music/Gaming/Read/Drawing/Coding/TV/Bathing/Shopping/Cooking/Work/Call/Car/Hanger/Spectator/RaisedHand/Whisper/Exclamation/Hearing/LoveRope/LoveGag/LoveLock/Wardrobe/Fork

部位: Arms/Hands/Legs/Feet/Mouth/Head/Neck/Torso/Pelvis/Breast/Eyes/Ears/Vulva
道具: 从【可操作道具清单】里选，用英文 Name。用户说中文名时自己找对应英文名。清单没有的不要编造。
颜色: 除"默认/原色"外必须输出 #RRGGBB，自己根据描述判断好看的 hex。用户给 hex 时原样使用。
属性: 从清单里选值。振动强度可用 Off/Low/Medium/High/Maximum/Random/Escalate/Tease/Deny/Edge。
常见 layer 名: Bed=床体, Blanket=毛毯, Inner=内衬, Strap=束带, Straps=束带, Frame=框架, Base=底座, Front=正面, Back=背面, Padding=软垫, Sheet=外层布料, Mattress=床垫, Pillow=枕头, Rivets=铆钉, Buckle=扣环, Buckles=扣环, Laces=系带, Lacing=系带, LacingBack=后系带, LacingTrim=系带镶边, Studs=钉饰, Trim=镶边, Panel=面板, Mesh=网面, Gloss=光泽, Shine=光泽, Pad=爪垫, Paws=爪垫, Lock=锁, Locks=锁, Chain=链条, Chains=链条, Ring=环, Rings=环, Belt=腰带, Belts=腰带, Metal=金属, Display=显示屏, Band=头梁/腕带, Text=文字, Barcode=条形码

操作要点：
- 编号从【当前房间角色名单】里找，不要猜测
- 可以对自己(#194331)使用所有指令
- 被锁的道具无法移除/复制；复制束缚只复制未锁 Item 道具
- 复合请求必须输出所有指令（如"绑手绑脚加口球"=3条指令），每条一行
- ITEMSET 的样式值必须来自同一目标 group 下该道具自己的清单；绝不能把 ItemArms 的 Hogtied 等样式套给 ItemLegs/ItemFeet。
- “驷马缚/Hogtie”必须实际输出有效的 Hogtie 样式 ITEMSET；只给四肢添加普通绳索不算完成，也不要擅自附加口塞。
- 日常聊天不输出操作指令，只有用户明确要求时才输出
- 做不到时说"好像做不到呢"

示例：
用户: 御坂把咲移到伊水左边
你回复:
[MOVE:166706:to:182401:left]
好了，已经移过去了~

用户: 御坂站到最左边
你回复:
[MOVE:194331:edge:left]
我试试往最左边挪。

用户: 御坂把你脚上的红色麻绳解掉
你回复:
[ITEMDEL:194331:HempRope:Feet]
脚上这条解掉了。

用户: 御坂，把你刚才保存的束缚快照恢复回来
你回复:
[SNAPSHOT:restore:194331]
恢复回来了。

用户: 御坂，放你自己出来，但如果不确定就先问我
你回复:
你具体想让我解开哪件？

【语义精确规则】
- 只执行【当前必须处理的最新消息】里的请求。历史消息只用来理解语境，不要补做旧消息里没完成、没确认或已经跳过的操作。
- "可以转正了"≠"已经转正了"，"想加道具"≠"已经加了道具"。按字面意思理解，不要脑补。
- "改回来/改回去"是指之前的颜色，不是当前颜色。不知道就说不记得，不要瞎猜。
- 改自己道具颜色时，除非用户明确说颜色，否则问用户想要什么颜色。

${timeText}${roomLogText}${rosterText}${refinedText}${profileText}${personaExtraText}
${itemCatalogText}

【当前房间】Gimp Dolls — 房间。
房间里的 GIMP XXX 是被束缚的人偶，编号就是名字里的数字。
你是房间管理员，清楚谁是娃娃谁是玩家。不要把普通玩家归类为娃娃。`;  },

  colorName(hex) {
      if (!hex || hex === "Default") return "默认色";
      const raw = String(hex);
      hex = raw.replace("#", "").toUpperCase();
      if (!/^[0-9A-F]{6}$/.test(hex)) return raw;
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
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
      const hue = h * 360;
      if (l > 0.82 && r >= g && g >= b && (r - b) > 10 && hue >= 25 && hue < 75) return "淡金";
      if (l > 0.75 && s < 0.22 && hue >= 25 && hue < 75) return "米色";
      if (s < 0.1) {
        if (l > 0.93) return "白色";
        if (l > 0.6) return "浅灰";
        if (l > 0.3) return "灰色";
        if (l > 0.1) return "深灰";
        return "黑色";
      }
      if (s < 0.25 && hue >= 200 && hue < 250) return l > 0.5 ? "灰蓝" : "深蓝灰";
      if (hue >= 15 && hue < 50 && l < 0.45) return "棕色";
      if (hue >= 25 && hue < 70 && l > 0.6 && s > 0.3) return "金色";
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
  },

  getColorName(color) {
    const value = Array.isArray(color)
      ? (color.find(c => c && c !== "Default") || color[0])
      : color;
    return this.colorName(value);
  },

  getEffectiveHairParts(char) {
    if (!char || !Array.isArray(char.Appearance)) return [];
    const best = {};
    for (const a of char.Appearance) {
      if (!a.Asset || !a.Asset.Group) continue;
      const gName = a.Asset.Group.Name || "";
      const gDesc = a.Asset.Group.Description || "";
      const cleanDesc = gDesc.replace(/^🍔/, "").replace(/\(覆盖\)/, "").trim();
      const label = `${gName} ${cleanDesc} ${a.Asset.Name || ""}`;
      let part = "";
      if (/前发|前髮|HairFront|新前发|新前髮/i.test(label)) part = "前发";
      else if (/后发|後发|后髮|後髮|HairBack|新后发|新後发|新后髮|新後髮/i.test(label)) part = "后发";
      else continue;
      const isOverride = /覆盖/.test(gDesc) || /^新/.test(gName) || /_Luzi|Luzi_/i.test(gName);
      const priority = isOverride ? 100 : 10;
      const color = Array.isArray(a.Color) ? (a.Color.find(c => c && c !== "Default") || a.Color[0]) : a.Color;
      const entry = { part, color: this.colorName(color), priority };
      if (!best[part] || best[part].priority <= priority) best[part] = entry;
    }
    return ["前发", "后发"].map(p => best[p]).filter(Boolean);
  },

  buildCompactRoster(chars, selfMemberNumber) {
    if (!chars || !Array.isArray(chars)) return "";
    const lines = [];
    // 先收集 mod 覆盖信息
    for (const c of chars) {
      const isSelf = c.MemberNumber === selfMemberNumber;
      const name = c.Nickname || c.Name || "?";
      const isDoll = name.startsWith("GIMP ");
      const tag = isDoll ? "[娃娃]" : (isSelf ? "[自己]" : "[玩家]");

      // 发色
      const hairParts = this.getEffectiveHairParts(c);
      const hair = hairParts.length > 0
        ? [...new Set(hairParts.map(p => p.color))].join("/")
        : "";

      // 主人/恋人
      let owner = "";
      if (c.Ownership && c.Ownership.Name) {
        owner = c.Ownership.Name + (c.Ownership.MemberNumber ? `#${c.Ownership.MemberNumber}` : "");
      }
      let lovers = "";
      if (Array.isArray(c.Lovership) && c.Lovership.length > 0) {
        lovers = c.Lovership.map(l => l.Name + (l.Stage === 2 ? "(正式)" : "")).join(",");
      }

      let description = "";
      if (c.Description) {
        const rawDesc = String(c.Description).replace(/\s+/g, " ").trim().slice(0, 220);
        const normalChars = (rawDesc.match(/[\u0020-\u007e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
        description = rawDesc && normalChars / rawDesc.length >= 0.7 ? rawDesc : "乱码/损坏";
      }

      // 道具统计 + 关键穿着
      let items = 0, locks = 0;
      const clothes = [];
      const itemList = [];
      if (c.Appearance && Array.isArray(c.Appearance)) {
        // 识别 mod 覆盖
        const overrideDescs = new Set();
        for (const a of c.Appearance) {
          if (a.Asset?.Group?.Description && /覆盖/.test(a.Asset.Group.Description)) {
            overrideDescs.add(a.Asset.Group.Description.replace(/^🍔/, "").replace(/\(覆盖\)/, "").trim());
          }
        }
        for (const a of c.Appearance) {
          if (!a.Asset?.Group) continue;
          const gName = a.Asset.Group.Name || "";
          const gDesc = a.Asset.Group.Description || "";
          // 跳过被 mod 覆盖的原版
          if (!/覆盖/.test(gDesc) && overrideDescs.has(gDesc.replace(/^🍔/, "").replace(/\(覆盖\)/, "").trim())) continue;

          if (gName.startsWith("Item")) {
            items++;
            if (a.Property?.LockedBy) locks++;
            // 记录具体道具名(中文名+英文名,LLM 操作时需要英文名)
            const itemDesc = a.Asset.Description || a.Asset.Name || "";
            const itemName = a.Asset.Name || "";
            const partTag = this.itemGroupPart(gName);
            const colorTag = this.itemColorSummary(a.Color);
            const lockTag = a.Property?.LockedBy ? "[锁]" : "";
            itemList.push(`${itemDesc}(${itemName})@${partTag}/${gName}${colorTag ? `[色:${colorTag}]` : ""}${lockTag}`);
            continue;
          }
          // 只保留有视觉意义的穿着
          if (/^(Cloth|Socks|Shoes|Gloves|Hat|Mask|Neck|Tail|Ears|Suit|Pantyhose|Bra|Panties|Corset)/.test(gName)) {
            const label = gDesc ? gDesc.replace(/^🍔/, "").replace(/\(覆盖\)/, "").trim() : gName;
            const assetDesc = a.Asset.Description || a.Asset.Name || "";
            const colors = a.Color
              ? [...new Set((Array.isArray(a.Color) ? a.Color : [a.Color])
                  .map(c => this.colorName(c)).filter(c => c && c !== "默认色"))].join("/")
              : "";
            clothes.push(`${label}:${assetDesc}${colors ? `(${colors})` : ""}`);
          }
        }
      }

      const aliases = [];
      if (c.Nickname && c.Name && c.Nickname !== c.Name) aliases.push(c.Name);
      const romanizedAlias = ({ yishui: "伊水" })[(c.Name || "").toLowerCase()];
      if (romanizedAlias && romanizedAlias !== c.Nickname && romanizedAlias !== c.Name) aliases.push(romanizedAlias);
      const aliasText = aliases.length > 0 ? `/${aliases.join("/")}` : "";
      let line = `${tag} ${name}${aliasText}#${c.MemberNumber}`;
      if (owner) line += ` 主人:${owner}`;
      if (lovers) line += ` 恋人:${lovers}`;
      if (description) line += ` 描述:${description}`;
      if (hair) line += ` 发:${hair}`;
      if (clothes.length > 0) line += ` 穿:${clothes.join(",")}`;
      if (itemList.length > 0) line += ` 道具:${itemList.join(",")}`;
      else if (items || locks) line += ` ${items}件${locks}锁`;
      lines.push(line);
    }
    return lines.join("\n");
  }
};
