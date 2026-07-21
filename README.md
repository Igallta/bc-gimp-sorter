# BC Gimp Sorter / MisakaChat

为 Bondage Club 的 Gimp Dolls 房间维护的两个用户脚本：

- **GimpSorter v1.6.5**：按编号自动整理 `GIMP XXX` 娃娃的位置。
- **MisakaChat v2.10.16**：御坂房间 Bot，提供角色对话、人物档案、语义记忆、长期记忆、角色扮演和受控的 BC 操作。

当前支持 BC 的 `R*` 版本路径，不再绑定特定的 R129/R130：

```text
https://*.bondageprojects.elementfx.com/R*/*
https://*.bondage-europe.com/R*/*
https://*.bondageprojects.com/R*/*
https://*.bondage-asia.com/club/R*
https://*.bondageclub.com/R*/*
http://localhost:*/*
```

## 安装

Tampermonkey 分别安装：

- [gimp-sorter.user.js](https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/gimp-sorter.user.js)
- [misaka-chat.user.js](https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-chat.user.js)

两个 loader 都只会在御坂账号（MemberNumber `194331`）上启动。

MisakaChat 的对话和 embedding 凭据不写入仓库。安装后通过 `/misaka key`、`/misaka embedkey` 或浏览器本地存储配置。

## 常用命令

### GimpSorter

```text
/gimpsorter on
/gimpsorter off
/gimpsorter status
```

### MisakaChat

```text
/misaka on|off
/misaka status
/misaka key <key>
/misaka embedkey <openrouter-key>
/misaka model <name>
/misaka memory
/misaka export|import
/misaka persona <text>
/misaka forget
```

`/misaka forget` 会清空人物档案、语义记忆和提炼长期记忆，使用前应先导出备份。

## 文档

完整的架构、数据结构、发布流程、版本决策、已知问题和路线图见：

- [技术手册](docs/TECHNICAL.md)

该技术手册是仓库内的当前事实来源。聊天记录、Notion Project Hub 和历史日记可作补充，但如果内容冲突，应先以运行代码和技术手册为准。

## 仓库结构

```text
gimp-sorter.user.js   Tampermonkey loader
gimp-sorter.js        GimpSorter runtime
misaka-chat.user.js   Tampermonkey loader、版本及固定资源 revision
misaka-chat.js        MisakaChat 主运行时
misaka-persona.js     人设、目录翻译和提示词辅助
bc-cn-translation.json BC 中文资源映射
docs/TECHNICAL.md     项目技术手册与路线图
backups/              历史源码备份，不参与运行
```

## 发布原则

MisakaChat 使用固定 Git revision 加载 runtime。每次发布必须同时核对：

1. `misaka-chat.user.js` 的 `@version`
2. loader 中的 `SCRIPT_VERSION`
3. `misaka-chat.js` 的 `SCRIPT_VERSION`
4. loader 中的 `ASSET_REVISION`
5. 固定 revision 返回的 `misaka-persona.js` 与 `misaka-chat.js`

只修改版本号但没有更新 `ASSET_REVISION`，会导致 Tampermonkey 显示新版本、实际运行旧代码。
