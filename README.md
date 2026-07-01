# BC Gimp Sorter

Bondage Club addon — Gimp Doll 房间自动排序脚本。

## 功能

- 自动检测 `GIMP XXX` 命名的娃娃掉线重连
- 按 GIMP 编号从小到大自动排列到房间最前面
- 使用 `MoveLeft` + `Publish: false`，不刷屏
- 通过 `/gimpsorter on|off|status` 控制开关

## 安装

1. 在 BC 的 Addon Manager (FUSAM) 中添加以下 URL：
   ```
   https://igallta.github.io/bc-gimp-sorter/gimp-sorter.js
   ```
2. 刷新页面，聊天框出现 `[GimpSorter] Gimp Doll 自动排序 v1.3 已加载` 即成功

## 掉线重连

脚本通过 FUSAM addon manager 加载，掉线重连后自动重新加载，无需手动操作。

## 命令

| 命令 | 说明 |
|------|------|
| `/gimpsorter on` | 开启自动排序 |
| `/gimpsorter off` | 关闭自动排序 |
| `/gimpsorter status` | 查看当前状态和 GIMP 位置 |