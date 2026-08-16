// Misaka iPad Guard v0.1.1
// iPadOS Safari WebContent 定时受控回收。与 MisakaChat/GimpSorter 主逻辑完全独立。
(function () {
  "use strict";

  const VERSION = "0.1.1";
  const MEMBER_NUMBER = 194331;
  const CONFIG_KEY = "misaka_ipad_guard_config_v1";
  const LOG_KEY = "misaka_ipad_guard_log_v1";
  const PENDING_KEY = "misaka_ipad_guard_pending_v1";
  const DEFAULTS = Object.freeze({
    enabled: false,
    intervalMinutes: 45,
    quietSeconds: 90,
    maxDeferMinutes: 10,
  });

  if (window.__MisakaIPadGuard) return;

  function isIPad() {
    return /iPad/i.test(navigator.userAgent || "") ||
      (navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1);
  }

  function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      enabled: source.enabled === true,
      intervalMinutes: clampNumber(source.intervalMinutes, DEFAULTS.intervalMinutes, 15, 240),
      quietSeconds: clampNumber(source.quietSeconds, DEFAULTS.quietSeconds, 15, 600),
      maxDeferMinutes: clampNumber(source.maxDeferMinutes, DEFAULTS.maxDeferMinutes, 1, 60),
    };
  }

  function readJSON(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function safePageLabel() {
    return `${location.hostname}${location.pathname}`;
  }

  function appendLog(type, details) {
    const records = readJSON(LOG_KEY, []);
    const list = Array.isArray(records) ? records : [];
    list.push({
      time: Date.now(),
      type: String(type || "event"),
      details: details && typeof details === "object" ? details : {},
      page: safePageLabel(),
      screen: typeof CurrentScreen === "undefined" ? "unknown" : String(CurrentScreen),
      online: navigator.onLine !== false,
      hidden: document.hidden === true,
    });
    while (list.length > 80) list.shift();
    writeJSON(LOG_KEY, list);
  }

  function getInputText() {
    try {
      if (typeof ElementValue === "function") return String(ElementValue("InputChat") || "").trim();
    } catch (_) {}
    const input = document.getElementById("InputChat");
    return String(input?.value || "").trim();
  }

  function socketConnected() {
    try {
      if (typeof ServerSocket === "undefined" || !ServerSocket) return null;
      return ServerSocket.connected !== false && ServerSocket.disconnected !== true;
    } catch (_) {
      return null;
    }
  }

  function sendLocal(message) {
    try {
      if (typeof CurrentScreen === "undefined" || CurrentScreen !== "ChatRoom") return;
      ChatRoomMessage({
        Content: `<font color="#72D6FF">[iPadGuard] ${message}</font>`,
        Type: "LocalMessage",
        Sender: Player.MemberNumber,
      });
    } catch (_) {}
  }

  let config = normalizeConfig(readJSON(CONFIG_KEY, {}));
  let startedAt = Date.now();
  let lastActivityAt = Date.now();
  let nextRecycleAt = startedAt + config.intervalMinutes * 60_000;
  let dueSince = 0;
  let lastDeferralReason = "";
  let lastTimerTick = Date.now();
  let timer = null;

  function persistConfig() {
    writeJSON(CONFIG_KEY, config);
  }

  function recycle(reason) {
    const pending = {
      startedAt: Date.now(),
      reason: String(reason || "manual"),
      returnPage: safePageLabel(),
      version: VERSION,
    };
    writeJSON(PENDING_KEY, pending);
    appendLog("recycle-start", pending);
    // 同站完整刷新已在 iPad 实机验证可保留御坂登录态并由 BC 自动回原房间。
    // reload 会销毁当前 Document、DOM、定时器和 JS 堆，同时避免跨站后落入登录页。
    window.addEventListener("unload", () => {}, { once: true });
    location.reload();
  }

  function evaluateBlockReason(now) {
    if (typeof CurrentScreen === "undefined" || CurrentScreen !== "ChatRoom") return "not-in-room";
    if (navigator.onLine === false) return "offline";
    if (window.__misakaReplyInProgress || window.__misakaGlobalBusy) return "misaka-busy";
    if (getInputText()) return "typing";
    if (now - lastActivityAt < config.quietSeconds * 1000) return "room-active";
    return "";
  }

  function checkSchedule(now) {
    if (!config.enabled || now < nextRecycleAt) return;
    if (!dueSince) dueSince = now;

    const blockReason = evaluateBlockReason(now);
    const maxDeferAt = dueSince + config.maxDeferMinutes * 60_000;
    if (blockReason && now < maxDeferAt) {
      if (blockReason !== lastDeferralReason) {
        appendLog("recycle-deferred", { reason: blockReason });
        lastDeferralReason = blockReason;
      }
      return;
    }
    if (blockReason === "misaka-busy" || blockReason === "typing" || blockReason === "not-in-room") return;
    recycle(blockReason ? `deadline:${blockReason}` : "scheduled");
  }

  function onTick() {
    const now = Date.now();
    const driftMs = now - lastTimerTick - 15_000;
    if (driftMs > 10_000) appendLog("timer-drift", { driftMs });
    lastTimerTick = now;
    checkSchedule(now);
  }

  function minutesUntil(timestamp) {
    return Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000));
  }

  function handleCommand(message) {
    const raw = String(message || "").trim();
    if (!raw.startsWith("/ipadguard")) return false;
    const parts = raw.slice("/ipadguard".length).trim().split(/\s+/).filter(Boolean);
    const sub = String(parts[0] || "status").toLowerCase();

    if (sub === "on") {
      config.enabled = true;
      nextRecycleAt = Date.now() + config.intervalMinutes * 60_000;
      dueSince = 0;
      persistConfig();
      appendLog("enabled", { intervalMinutes: config.intervalMinutes });
      sendLocal(`已开启；${config.intervalMinutes} 分钟后尝试受控回收`);
    } else if (sub === "off") {
      config.enabled = false;
      persistConfig();
      appendLog("disabled", {});
      sendLocal("已关闭自动回收");
    } else if (sub === "interval") {
      const value = clampNumber(parts[1], NaN, 15, 240);
      if (!Number.isFinite(value)) {
        sendLocal("用法: /ipadguard interval <15-240分钟>");
      } else {
        config.intervalMinutes = value;
        nextRecycleAt = Date.now() + value * 60_000;
        dueSince = 0;
        persistConfig();
        appendLog("interval-changed", { intervalMinutes: value });
        sendLocal(`自动回收间隔已设为 ${value} 分钟`);
      }
    } else if (sub === "recycle") {
      sendLocal("2 秒后执行手动受控回收");
      setTimeout(() => recycle("manual"), 2000);
    } else if (sub === "log") {
      const records = readJSON(LOG_KEY, []);
      window.__misakaIPadGuardLogExport = JSON.stringify(records, null, 2);
      sendLocal(`已导出 ${Array.isArray(records) ? records.length : 0} 条日志到 window.__misakaIPadGuardLogExport`);
    } else if (sub === "clear") {
      localStorage.removeItem(LOG_KEY);
      sendLocal("诊断日志已清空");
    } else if (sub === "status") {
      sendLocal(`v${VERSION} ${isIPad() ? "iPad" : "非iPad"} | 自动回收 ${config.enabled ? "开启" : "关闭"} | 间隔 ${config.intervalMinutes} 分钟 | 下次约 ${minutesUntil(nextRecycleAt)} 分钟 | Socket ${socketConnected() === false ? "断开" : "正常"}`);
    } else {
      sendLocal("用法: /ipadguard on|off|status|recycle|interval <分钟>|log|clear");
    }
    return true;
  }

  function commandFromSendArgs(args) {
    // BC 的 ChatRoomSendChat 通常直接读取 InputChat；移动端传入的 args[0]
    // 可能为空或是其他字符串。始终优先读取真实输入框，避免命令漏给 BC。
    const input = getInputText();
    if (input) return input;
    return typeof args?.[0] === "string" ? String(args[0]).trim() : "";
  }

  function consumeCommand(args) {
    const message = commandFromSendArgs(args);
    if (!message.startsWith("/ipadguard") || !handleCommand(message)) return false;
    try { ElementValue("InputChat", ""); } catch (_) {
      const input = document.getElementById("InputChat");
      if (input) input.value = "";
    }
    return true;
  }

  function installHooks() {
    const existing = bcModSdk.getModsInfo().find((entry) => entry.name === "MisakaIPadGuard");
    const mod = existing
      ? { hookFunction: () => {} }
      : bcModSdk.registerMod({
          name: "MisakaIPadGuard",
          fullName: "Misaka iPad WebContent Guard",
          version: VERSION,
          repository: "https://github.com/Igallta/bc-gimp-sorter",
        });

    mod.hookFunction("ChatRoomMessage", 20, (args, next) => {
      const data = args?.[0];
      if (data && data.Type !== "LocalMessage") lastActivityAt = Date.now();
      return next(args);
    });

    mod.hookFunction("ChatRoomSendChat", 20, (args, next) => {
      if (consumeCommand(args)) return;
      return next(args);
    });

    // iPad/Safari 上 bcModSdk 的发送 hook 偶尔没有接到移动端按钮路径。
    // 再包装页面实际入口；普通聊天仍原样交给 SDK 链和 BC。
    if (!window.__misakaIPadGuardSendWrapped && typeof window.ChatRoomSendChat === "function") {
      const originalSend = window.ChatRoomSendChat;
      window.__misakaIPadGuardOriginalSend = originalSend;
      window.ChatRoomSendChat = function () {
        if (consumeCommand(Array.from(arguments))) return;
        return originalSend.apply(this, arguments);
      };
      window.__misakaIPadGuardSendWrapped = true;
    }
  }

  function installLifecycleLogging() {
    window.addEventListener("online", () => appendLog("online", {}));
    window.addEventListener("offline", () => appendLog("offline", {}));
    window.addEventListener("pagehide", (event) => appendLog("pagehide", { persisted: !!event.persisted }));
    window.addEventListener("pageshow", (event) => appendLog("pageshow", { persisted: !!event.persisted }));
    document.addEventListener("visibilitychange", () => appendLog("visibility", { state: document.visibilityState }));
    window.addEventListener("error", (event) => appendLog("window-error", { message: String(event.message || "unknown").slice(0, 300) }));
    window.addEventListener("unhandledrejection", (event) => appendLog("unhandled-rejection", { message: String(event.reason?.message || event.reason || "unknown").slice(0, 300) }));
  }

  function init() {
    const pending = readJSON(PENDING_KEY, null);
    if (pending) {
      appendLog("recycle-return", { elapsedMs: Date.now() - Number(pending.startedAt || Date.now()), reason: pending.reason || "unknown" });
      localStorage.removeItem(PENDING_KEY);
    }
    appendLog("runtime-start", { version: VERSION, iPad: isIPad() });
    installLifecycleLogging();
    installHooks();
    timer = setInterval(onTick, 15_000);
    window.__MisakaIPadGuard = {
      version: VERSION,
      get config() { return { ...config }; },
      get startedAt() { return startedAt; },
      get lastActivityAt() { return lastActivityAt; },
      get nextRecycleAt() { return nextRecycleAt; },
      handleCommand,
      recycle,
      dispose() {
        if (timer) clearInterval(timer);
        timer = null;
      },
    };
    window.__MisakaIPadGuardTestHooks = { normalizeConfig, evaluateBlockReason };
    console.log(`[iPadGuard] v${VERSION} ready; auto recycle ${config.enabled ? "on" : "off"}`);
    sendLocal(`v${VERSION} 已加载；自动回收${config.enabled ? "开启" : "关闭"}`);
  }

  if (typeof Player === "undefined" || Number(Player?.MemberNumber || Player?.ID) !== MEMBER_NUMBER) return;
  if (typeof bcModSdk === "undefined") return;
  init();
})();
