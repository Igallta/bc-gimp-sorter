# BC Gimp Sorter / MisakaChat

为 Bondage Club 的 Gimp Dolls 房间维护的两个用户脚本：

- **GimpSorter v1.7.4**：按 `GIMP → Gimp → Doll → GIMP Pet → Pet → Error` 分类；组内先排三位编号，再排四位编号，并各自按数值升序整理。
- **MisakaChat v3.0.9**：御坂房间 Bot，提供结构化角色回复、人物与长期记忆、角色扮演、BC 原生互动、语境表情包、好友能力和受控的 BC 操作；密集点名时最多排队五条，并使用 BC 原生消息引用明确回复对象。结构化回复不可用时最多尝试五次，仍失败会引用原消息提示联系咲修复，然后继续处理队列。

另提供一个默认关闭、仅供 iPadOS 长期挂机使用的独立守护脚本：

- **Misaka iPad Guard v0.3.8**：在 WebContent 被 Jetsam 回收前跨站释放网页进程，返回 BC 后先等待 5 秒供插件加载，再使用 Tampermonkey 私有存储中的御坂密码调用 BC 原生登录并恢复原房间，同时保存本地生命周期日志；三套脚本不在进房初始化时写入聊天框，命令反馈仍采用统一的状态顺序、反馈句式与蓝色。

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

iPadOS 可选安装：

- [misaka-ipad-guard.user.js](https://raw.githubusercontent.com/Igallta/bc-gimp-sorter/master/misaka-ipad-guard.user.js)

这些脚本都只会在御坂账号（MemberNumber `194331`）上启动；iPad Guard 默认不启用自动回收。

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
/misaka embedkey <openai-key>
/misaka model <name>
/misaka memory
/misaka export|import
/misaka persona <text>
/misaka forget
```

### iPad Guard

首次安装后，在房间内执行 `/ipadguard login`，或从 Tampermonkey 菜单选择“设置御坂自动登录密码”。账号固定为 `MSK002`；密码以明文保存在 Tampermonkey 私有数据中，不写入网页 localStorage、URL、日志或仓库。登录时密码会短暂传给 BC 原生 `LoginDoLogin`，登录完成后仍校验成员编号必须为 `194331`。保持自动回收默认关闭，先配置密码并手动验证完整流程：

```text
/ipadguard status
/ipadguard login
/ipadguard recycle
```

确认跨站返回后自动登录为御坂账号、自动返回原房间且两个主脚本重新加载后再开启：

```text
/ipadguard on
/ipadguard interval 45
/ipadguard off
/ipadguard log
```

自动回收不会因房间聊天、动作或 GIMP 系统消息延期；到期时只等待输入框清空、御坂完成当前任务并确认仍在房间。离开 BC 前会依次探测 GitHub Pages 主释放页与独立 Fly.io origin 的 httpbingo 备用页；只跳转到已确认可访问的远程页，二者均不可用时留在 BC 并在下一轮重试。主释放页通过 URL fragment 接收返回地址；备用页只接收去除查询参数和 fragment 的 BC 页面地址，并通过 HTTP Refresh 返回。若停在登录页，loader 会从登录页首次就绪起等待 5 秒，让 WCE、其他 Tampermonkey 脚本与 BC 组件完成初始化，然后填充 BC 原生表单并调用 `LoginDoLogin`。每个页面最多自动尝试一次，回房仍由 BC 的 `ReturnToChatRoom` 完成。密码错误时不会循环重试；登录后的成员编号不是 `194331` 时，Guard 不会继续加载。可随时从 Tampermonkey 菜单清除私有凭据。

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
