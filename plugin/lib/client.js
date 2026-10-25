/* ============================================================================
 * dsh-token-mascot · 浏览器侧入口 (lib/client.js)
 * ----------------------------------------------------------------------------
 * 单个文件、零构建、零运行时依赖（只 require 宿主静态模块表里的 react / react-dom）。
 *
 * 加载约定（与官方 @deepseek-ai/dsh-client-ui-* 包完全一致）：
 *   - 由 dsh-client-modules 扫描 Loader 树中的 dsh.client 行，
 *     通过 /plugins/dsh-token-mascot/client.js 提供给浏览器；
 *   - 浏览器用 window.__ModuleLoader__.load({ id, factory }) 注册模块；
 *   - 模块导出 { apply, inject }，apply(ctx, config) 在插件挂载时调用。
 *
 * 数据来源（全部走官方公开面，不自己数 token、不发网络请求）：
 *   - useProjection("tokenUsage")      会话累计：uncachedInputTokens / outputTokens /
 *                                      cacheReadTokens / cacheWriteTokens（官方 token-meter 投影）
 *   - useProjection("contextPressure") 上下文压力：projectedTokens | pressureTokens + contextWindow
 *   - useProjection("sessionStats")    整会话墙钟：decodeTokens / decodeMs（解码速率）
 *   - useProjection("todos")           当前任务（官方 todo 投影）
 *   - useSession((s) => s)             会话运行态：running / lastAgentError（rc.3 起是选择器 hook）
 *   - useSessions((s) => s)            全局会话列表 + updatedAt（今日合计的会话筛选）
 *   - ctx.sessions.refreshProjections(id)  按需读取各会话投影（今日会话 tokenUsage 求和）
 *   - ctx.sessions.binding(id).eventSource  流式 assistant/live-chunk（本步实时增量估算）
 *
 * 角色素材：用户提供的 Q 版表情包，本地抠图/去标签后压缩为 6 张 WebP data URI（见 PET_IMAGES），
 * 单文件内嵌、零外链、运行时零网络请求。
 *
 * 失败模式：任何一环缺失都静默降级（数字显示 0 / 隐藏该行），绝不抛错、绝不阻塞宿主。
 * ========================================================================== */
(function () {
  "use strict";

  var PLUGIN_ID = "dsh-token-mascot";
  var SLOT_NAME = "conversation.input.right";
  var STYLE_ID = PLUGIN_ID + "/style";
  var POS_KEY = "dsh-token-mascot:position:v1";
  var TODAY_BASE_KEY = "dsh-token-mascot:today-baseline:v1";
  var DEFAULT_PET_SIZE = 112;
  var OPEN_KEY = "dsh-token-mascot:open:v1";

  /* ══════════════════════════ 纯函数（可离线单测） ══════════════════════════ */

  function num(value) {
    return typeof value === "number" && isFinite(value) ? value : 0;
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  /** 统计一段文本的 CJK 字符数与非 CJK 字符数（token 估算用）。 */
  function countText(text) {
    if (typeof text !== "string" || text.length === 0) return { cjk: 0, other: 0 };
    var cjk = 0;
    var other = 0;
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (
        (code >= 0x2e80 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xff00 && code <= 0xffef) ||
        (code >= 0x3000 && code <= 0x303f)
      ) {
        cjk += 1;
      } else {
        other += 1;
      }
    }
    return { cjk: cjk, other: other };
  }

  /**
   * token 估算（与官方 token-meter 的固定启发式同量级：约 4 字符 / token，CJK 约 1 字 / token）。
   * 接受数字（字符数）或字符串。
   */
  function estimateTokens(value) {
    if (typeof value === "number") return value > 0 ? Math.ceil(value / 4) : 0;
    if (typeof value !== "string" || value.length === 0) return 0;
    var counts = countText(value);
    return Math.ceil(counts.cjk + counts.other / 4);
  }

  function formatExact(value) {
    var n = Math.max(0, Math.round(num(value)));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function formatTokens(value) {
    var n = Math.max(0, Math.round(num(value)));
    if (n < 1000) return String(n);
    if (n < 100000) return String(Math.round(n / 100) / 10).replace(/\.0$/, "") + "k";
    if (n < 1000000) return String(Math.round(n / 1000)) + "k";
    return String(Math.round(n / 10000) / 100).replace(/\.?0+$/, "") + "M";
  }

  /**
   * 中文口径的大数：≥1亿用「亿」（两位小数，如 1.05亿），否则用「万」（取整，如 9134万）。
   * 不足 1 万直接显示原始数字。
   */
  function formatCn(value) {
    var n = Math.max(0, num(value));
    if (n >= 100000000) {
      var yi = Math.round(n / 1000000) / 100;
      return String(yi).replace(/\.?0+$/, "") + "亿";
    }
    if (n >= 10000) return String(Math.round(n / 10000)) + "万";
    return String(Math.round(n));
  }

  /** 百分比夹取到 0..100；非数字按 0 处理。 */
  function clampPercent(value) {
    var n = typeof value === "number" && isFinite(value) ? value : 0;
    return Math.round(clamp(n, 0, 100));
  }

  /** tokenUsage 投影 → 展示口径的拆解。 */
  function usageTotals(usage) {
    var source = usage || {};
    var uncached = num(source.uncachedInputTokens);
    var cacheRead = num(source.cacheReadTokens);
    var cacheWrite = num(source.cacheWriteTokens);
    var output = num(source.outputTokens);
    var billedInput = uncached + cacheRead + cacheWrite;
    return {
      uncached: uncached,
      cacheRead: cacheRead,
      cacheWrite: cacheWrite,
      output: output,
      billedInput: billedInput,
      total: billedInput + output,
    };
  }

  function cacheHitPercent(usage) {
    var totals = usageTotals(usage);
    if (totals.billedInput <= 0) return null;
    return Math.min(100, Math.max(0, Math.round((totals.cacheRead / totals.billedInput) * 100)));
  }

  /** contextPressure 投影 → 上下文占用。 */
  function contextOccupancy(pressure) {
    if (!pressure) return null;
    var used = pressure.projectedTokens !== undefined ? pressure.projectedTokens : pressure.pressureTokens;
    if (used === undefined || pressure.contextWindow === undefined) return null;
    if (!isFinite(used) || !isFinite(pressure.contextWindow) || pressure.contextWindow <= 0) return null;
    return {
      used: used,
      window: pressure.contextWindow,
      percent: clampPercent((used / pressure.contextWindow) * 100),
    };
  }

  /** 本地时区「今天 0 点」的时间戳（毫秒），用于筛选今日有活动的会话。 */
  function startOfLocalDay(now) {
    var date = new Date(typeof now === "number" && isFinite(now) ? now : Date.now());
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  /** 本地日期键：YYYY-MM-DD（用于按天保存「今日」基准）。 */
  function localDayKey(now) {
    var date = new Date(typeof now === "number" && isFinite(now) ? now : Date.now());
    var month = date.getMonth() + 1;
    var day = date.getDate();
    return date.getFullYear() + "-" + (month < 10 ? "0" + month : String(month)) + "-" + (day < 10 ? "0" + day : String(day));
  }

  /** 读取当天的会话 token 基准；换天自动作废。 */
  function readTodayBaseline(dayKey) {
    var stored = readStoredJSON(TODAY_BASE_KEY);
    if (
      stored &&
      stored.version === 1 &&
      stored.day === dayKey &&
      stored.sessions &&
      typeof stored.sessions === "object"
    ) {
      return stored;
    }
    return { version: 1, day: dayKey, sessions: {} };
  }

  function writeTodayBaseline(store) {
    writeStoredJSON(TODAY_BASE_KEY, store);
  }

  /** tokenUsage 投影 → 四个计费桶（数字）。 */
  function usageBucketsOf(usage) {
    var source = usage || {};
    return {
      uncachedInputTokens: num(source.uncachedInputTokens),
      cacheReadTokens: num(source.cacheReadTokens),
      cacheWriteTokens: num(source.cacheWriteTokens),
      outputTokens: num(source.outputTokens),
    };
  }

  function usageBucketTotal(buckets) {
    var source = buckets || {};
    return (
      num(source.uncachedInputTokens) +
      num(source.cacheReadTokens) +
      num(source.cacheWriteTokens) +
      num(source.outputTokens)
    );
  }

  /** 当前投影 - 今日基准 = 今日新增（逐桶，非负）。 */
  function subtractUsageBuckets(usage, base) {
    var current = usageBucketsOf(usage);
    var previous = usageBucketsOf(base);
    return {
      uncachedInputTokens: Math.max(0, current.uncachedInputTokens - previous.uncachedInputTokens),
      cacheReadTokens: Math.max(0, current.cacheReadTokens - previous.cacheReadTokens),
      cacheWriteTokens: Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens),
      outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    };
  }

  /**
   * 聚合多个会话的 tokenUsage 投影（每个元素是 tokenUsage 的 wire view）。
   * 返回展示口径的合计与「有消耗的会话数」。
   */
  function sumUsageBuckets(usages) {
    var result = {
      uncached: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      billedInput: 0,
      total: 0,
      sessions: 0,
    };
    if (!usages || usages.length === 0) return result;
    for (var i = 0; i < usages.length; i += 1) {
      var totals = usageTotals(usages[i]);
      if (totals.total <= 0) continue;
      result.uncached += totals.uncached;
      result.cacheRead += totals.cacheRead;
      result.cacheWrite += totals.cacheWrite;
      result.output += totals.output;
      result.billedInput += totals.billedInput;
      result.total += totals.total;
      result.sessions += 1;
    }
    return result;
  }

  /**
   * 从会话事件窗口的尾部找出「当前活跃 attempt」的流式增量，按字符估算本步 token。
   * entries 形如 { type: 'transient'|'durable', event: { type, seq, time, data } }。
   * 只扫尾部连续的 transient 段，O(尾部长度)，不整窗遍历。
   */
  function computeLiveStream(entries) {
    var empty = { attemptId: null, chars: 0, cjk: 0, other: 0, tokens: 0, tool: false };
    if (!entries || entries.length === 0) return empty;

    var attemptId = null;
    var cjk = 0;
    var other = 0;
    var tool = false;
    var decided = false;

    for (var i = entries.length - 1; i >= 0; i -= 1) {
      var entry = entries[i];
      if (!entry) continue;
      if (entry.type !== "transient") {
        if (attemptId !== null) break;
        continue;
      }
      var event = entry.event;
      if (!event || event.type !== "assistant/live-chunk") continue;
      var data = event.data || {};
      if (attemptId === null) attemptId = data.attemptId === undefined ? null : data.attemptId;
      if (attemptId === null) break;
      if (data.attemptId !== attemptId) break;

      var chunk = data.chunk || {};
      if (!decided) {
        decided = true;
        tool = chunk.type === "tool-call-delta";
      }
      if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
        var counts = countText(chunk.text);
        cjk += counts.cjk;
        other += counts.other;
      } else if (chunk.type === "tool-call-delta" && typeof chunk.argumentsDelta === "string") {
        other += chunk.argumentsDelta.length;
      }
    }

    return {
      attemptId: attemptId,
      chars: cjk + other,
      cjk: cjk,
      other: other,
      tokens: Math.ceil(cjk + other / 4),
      tool: tool,
    };
  }

  /** 任务标题文本（兼容 todo 投影的几种字段命名）。 */
  function todoText(todo) {
    if (!todo || typeof todo !== "object") return "";
    var text = todo.text || todo.content || todo.title || todo.label || todo.description || "";
    return typeof text === "string" ? text : "";
  }

  function todoStatus(todo) {
    return todo && typeof todo.status === "string" ? todo.status : "";
  }

  function hasRunningTodo(todos) {
    if (!Array.isArray(todos)) return false;
    for (var i = 0; i < todos.length; i += 1) {
      var status = todoStatus(todos[i]);
      if (status === "in_progress" || status === "in-progress" || status === "active" || status === "doing") {
        return true;
      }
    }
    return false;
  }

  /** 当前任务文案：错误 > 工具 > todo 进行中 > 思考中 > 待命。 */
  function pickTask(todos, session, live) {
    var snapshot = session || {};
    if (snapshot.lastAgentError) {
      var detail = String(snapshot.lastAgentError);
      return "出错了：" + (detail.length > 42 ? detail.slice(0, 42) + "…" : detail);
    }
    if (live && live.tool) return "正在调用工具…";
    if (Array.isArray(todos)) {
      for (var i = 0; i < todos.length; i += 1) {
        var status = todoStatus(todos[i]);
        if (status === "in_progress" || status === "in-progress" || status === "active" || status === "doing") {
          var label = todoText(todos[i]);
          return "正在做：" + (label.length > 48 ? label.slice(0, 48) + "…" : label || "未命名任务");
        }
      }
    }
    if (snapshot.running) return "思考 / 生成中…";
    if (Array.isArray(todos)) {
      var pending = 0;
      for (var j = 0; j < todos.length; j += 1) {
        if (todoStatus(todos[j]) === "pending") pending += 1;
      }
      if (pending > 0) return "待命中 · 还有 " + pending + " 项待办";
    }
    return "待命中 · 等你开工";
  }

  /**
   * 角色状态机：error / eat / work / think / happy / idle。
   * 输入：{ session, live, error, working, justFinished }
   */
  function deriveMascotState(input) {
    var source = input || {};
    var session = source.session || {};
    var live = source.live || {};
    if (source.error) return "error";
    if (session.running && num(live.tokens) > 0) return "eat";
    if (session.running) return source.working ? "work" : "think";
    if (source.justFinished) return "happy";
    return "idle";
  }

  /* ══════════════════════════ 样式 ══════════════════════════ */

  var CSS = [
    "/* dsh-token-mascot — 只作用于 .tm-* 命名空间，不碰宿主选择器 */",
    ".tm-root{position:fixed;z-index:1030;width:112px;height:112px;",
    "  --tm-fg:var(--dsw-alias-label-primary,#e8eaed);",
    "  --tm-fg2:var(--dsw-alias-label-secondary,#b6bcc4);",
    "  --tm-fg3:var(--dsw-alias-label-tertiary,#8a9099);",
    "  --tm-bg:var(--dsw-specific-menu,rgba(24,26,32,.94));",
    "  --tm-border:var(--dsw-alias-border-l1,rgba(255,255,255,.12));",
    "  --tm-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));",
    "  --tm-shadow:var(--dsw-elevation-prominent,0 14px 36px rgba(0,0,0,.42));",
    "  --tm-accent:#4d93f8;color:var(--tm-fg);",
    "  font-family:inherit;font-size:13px;line-height:1.45;user-select:none;",
    "}",
    ".tm-root *{box-sizing:border-box;}",
    ".tm-pet{position:relative;display:flex;align-items:center;justify-content:center;",
    "  width:100%;height:100%;padding:0;border:0;border-radius:50%;cursor:grab;",
    "  background:transparent;touch-action:none;outline:none;-webkit-tap-highlight-color:transparent;",
    "  filter:drop-shadow(0 6px 14px rgba(0,0,0,.34));transition:transform .16s ease;}",
    ".tm-pet:hover{transform:translateY(-2px) scale(1.03);}",
    ".tm-pet:active{cursor:grabbing;transform:scale(.98);}",
    ".tm-pet:focus-visible{box-shadow:0 0 0 2px var(--tm-accent);}",
    ".tm-pet-svg{display:flex;align-items:center;justify-content:center;width:100%;height:100%;pointer-events:none;}",
    ".tm-pet-img{display:block;height:calc(100% - 2px);width:auto;max-width:100%;object-fit:contain;",
    "  pointer-events:none;filter:drop-shadow(0 4px 8px rgba(0,0,0,.32));",
    "  transform-origin:50% 92%;will-change:transform;}",
    ".tm-svg-idle .tm-pet-img{animation:tm-bob 3.4s ease-in-out infinite;}",
    ".tm-svg-think .tm-pet-img{animation:tm-bob-fast 1.5s ease-in-out infinite;}",
    ".tm-svg-work .tm-pet-img{animation:tm-tilt 2.4s ease-in-out infinite;}",
    ".tm-svg-eat .tm-pet-img{animation:tm-chew .34s ease-in-out infinite;transform-origin:50% 92%;}",
    ".tm-svg-error .tm-pet-img{animation:tm-shake .42s ease-in-out 2;filter:drop-shadow(0 0 9px rgba(239,91,91,.7));}",
    ".tm-svg-happy .tm-pet-img{animation:tm-jump .72s cubic-bezier(.36,.07,.19,.97) 2;}",
    ".tm-badge{position:absolute;right:-8px;bottom:6px;padding:1px 7px;border-radius:999px;",
    "  background:var(--tm-bg);border:1px solid var(--tm-border);color:var(--tm-fg2);",
    "  font-size:11px;font-variant-numeric:tabular-nums;line-height:17px;white-space:nowrap;",
    "  box-shadow:0 4px 10px rgba(0,0,0,.28);pointer-events:none;}",
    ".tm-dots{position:absolute;top:6px;right:6px;display:none;gap:3px;padding:3px 5px;border-radius:999px;",
    "  background:var(--tm-bg);border:1px solid var(--tm-border);}",
    ".tm-dots i{display:block;width:3px;height:3px;border-radius:50%;background:var(--tm-fg2);",
    "  animation:tm-dot 1.1s ease-in-out infinite;}",
    ".tm-dots i:nth-child(2){animation-delay:.15s;}",
    ".tm-dots i:nth-child(3){animation-delay:.3s;}",
    ".tm-svg-think .tm-dots,.tm-svg-work .tm-dots,.tm-svg-eat .tm-dots{display:flex;}",
    ".tm-root[data-mood=think] .tm-dots,.tm-root[data-mood=work] .tm-dots,.tm-root[data-mood=eat] .tm-dots{display:flex;}",
    ".tm-spark{position:absolute;top:26px;width:4px;height:4px;border-radius:50%;background:#ffd166;",
    "  opacity:0;animation:tm-float-up .9s ease-out forwards;pointer-events:none;}",
    ".tm-card{position:absolute;bottom:calc(100% + 12px);right:0;width:312px;padding:14px;",
    "  border-radius:16px;background:var(--tm-bg);border:1px solid var(--tm-border);",
    "  backdrop-filter:var(--dsw-menu-backdrop-filter,blur(18px) saturate(1.25));",
    "  -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(18px) saturate(1.25));",
    "  box-shadow:var(--tm-shadow);color:var(--tm-fg);transform-origin:bottom right;",
    "  animation:tm-card-in .18s ease-out;cursor:default;}",
    ".tm-card.tm-left{left:0;right:auto;transform-origin:bottom left;}",
    ".tm-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}",
    ".tm-avatar{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:9px;",
    "  background:linear-gradient(140deg,rgba(124,196,255,.28),rgba(77,147,248,.14));border:1px solid var(--tm-border);}",
    ".tm-avatar img{width:22px;height:22px;display:block;object-fit:cover;border-radius:7px;}",
    ".tm-title{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--tm-fg);}",
    ".tm-state{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:11px;color:var(--tm-fg3);}",
    ".tm-state-dot{width:6px;height:6px;border-radius:50%;background:var(--tm-fg3);}",
    ".tm-state-dot.tm-on{background:#3ecf8e;box-shadow:0 0 0 3px rgba(62,207,142,.16);animation:tm-pulse 1.6s ease-in-out infinite;}",
    ".tm-state-dot.tm-err{background:#ef5b5b;box-shadow:0 0 0 3px rgba(239,91,91,.16);}",
    ".tm-close{width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--tm-fg3);",
    "  font-size:15px;line-height:20px;cursor:pointer;}",
    ".tm-close:hover{background:var(--tm-hover);color:var(--tm-fg);}",
    ".tm-total{display:flex;align-items:baseline;gap:6px;margin:2px 0 2px;}",
    ".tm-total-num{font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1.05;",
    "  font-variant-numeric:tabular-nums;color:var(--tm-fg);display:inline-block;}",
    ".tm-total-num.tm-bump{animation:tm-bump .5s ease-out;}",
    ".tm-total-unit{font-size:11px;color:var(--tm-fg3);}",
    ".tm-total-cn{font-size:11px;color:var(--tm-fg3);white-space:nowrap;}",
    ".tm-plus{margin-left:auto;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600;",
    "  color:#0f172a;background:linear-gradient(120deg,#7cc4ff,#4d93f8);",
    "  animation:tm-plus .9s ease-out forwards;font-variant-numeric:tabular-nums;}",
    ".tm-sub{display:flex;gap:10px;font-size:11px;color:var(--tm-fg3);min-height:16px;margin-bottom:9px;}",
    ".tm-meter{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:11px;",
    "  background:var(--tm-hover);margin-bottom:9px;}",
    ".tm-meter-bottom{margin-top:2px;margin-bottom:8px;}",
    ".tm-ring{width:30px;height:30px;flex:none;transform:rotate(-90deg);}",
    ".tm-ring-track{fill:none;stroke:var(--tm-border);stroke-width:3;}",
    ".tm-ring-fill{fill:none;stroke:var(--tm-accent);stroke-width:3;stroke-linecap:round;transition:stroke-dashoffset .35s ease;}",
    ".tm-meter-main{display:flex;flex-direction:column;gap:1px;min-width:0;}",
    ".tm-meter-top{display:flex;align-items:baseline;gap:6px;}",
    ".tm-meter-pct{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--tm-fg);}",
    ".tm-meter-cap{font-size:11px;color:var(--tm-fg3);}",
    ".tm-meter-bar{display:flex;width:100%;height:3px;border-radius:999px;overflow:hidden;background:var(--tm-border);margin-top:4px;}",
    ".tm-meter-seg{height:100%;background:var(--tm-accent);opacity:.9;}",
    ".tm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:9px;}",
    ".tm-cell{padding:6px 8px;border-radius:9px;background:rgba(127,127,127,.08);min-width:0;}",
    ".tm-cell span{display:block;font-size:10px;color:var(--tm-fg3);letter-spacing:.03em;}",
    ".tm-cell b{display:block;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--tm-fg2);",
    "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    ".tm-today{display:flex;align-items:center;gap:6px;width:100%;padding:7px 9px;border-radius:10px;",
    "  background:rgba(127,127,127,.06);border:1px solid var(--tm-border);margin-bottom:8px;min-width:0;",
    "  font:inherit;font-size:11px;color:var(--tm-fg3);text-align:left;cursor:pointer;appearance:none;}",
    ".tm-today:hover{border-color:var(--tm-accent);}",
    ".tm-today-open{border-color:var(--tm-accent);}",
    ".tm-today-icon{display:flex;flex:none;color:var(--tm-accent);}",
    ".tm-today-label{color:var(--tm-fg2);white-space:nowrap;}",
    ".tm-today-sub{font-size:10px;color:var(--tm-fg3);white-space:nowrap;}",
    ".tm-today b{margin-left:auto;font-size:14px;font-weight:650;color:var(--tm-fg);",
    "  font-variant-numeric:tabular-nums;letter-spacing:-.01em;white-space:nowrap;}",
    ".tm-today b.tm-today-loading{color:var(--tm-fg3);font-weight:500;}",
    ".tm-today-cn{font-size:10px;color:var(--tm-fg3);white-space:nowrap;margin-left:3px;}",
    ".tm-today-chev{flex:none;font-size:9px;color:var(--tm-fg3);transition:transform .16s ease;margin-left:2px;}",
    ".tm-today-open .tm-today-chev{transform:rotate(180deg);}",
    ".tm-today-list-wrap{display:grid;grid-template-rows:0fr;opacity:0;margin:0;overflow:hidden;",
    "  transition:grid-template-rows .24s cubic-bezier(.2,.7,.2,1),opacity .16s ease,margin .24s ease;}",
    ".tm-today-list-wrap.tm-open{grid-template-rows:1fr;opacity:1;margin:-2px 0 8px;}",
    ".tm-today-list-inner{min-height:0;overflow:hidden;}",
    ".tm-today-list{max-height:188px;overflow-y:auto;padding:4px 6px;",
    "  border:1px solid var(--tm-border);border-top:0;border-radius:0 0 10px 10px;background:rgba(127,127,127,.04);}",
    ".tm-today-item{display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:6px;",
    "  font-size:11px;color:var(--tm-fg2);}",
    ".tm-today-item + .tm-today-item{border-top:1px solid rgba(127,127,127,.08);}",
    ".tm-today-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".tm-today-item-tag{flex:none;font-size:9px;padding:0 4px;border-radius:999px;",
    "  background:rgba(77,147,248,.18);color:var(--tm-accent);}",
    ".tm-today-item-value{flex:none;font-variant-numeric:tabular-nums;font-weight:600;color:var(--tm-fg);}",
    ".tm-today-empty{padding:6px;font-size:10px;color:var(--tm-fg3);text-align:center;}",
    ".tm-task{display:flex;gap:7px;align-items:flex-start;padding:8px 10px;border-radius:11px;",
    "  background:linear-gradient(120deg,rgba(77,147,248,.14),rgba(77,147,248,.05));",
    "  border:1px solid rgba(77,147,248,.22);margin-bottom:8px;}",
    ".tm-task-icon{flex:none;margin-top:1px;color:var(--tm-accent);display:flex;}",
    ".tm-task-text{font-size:11.5px;color:var(--tm-fg2);word-break:break-word;max-height:34px;overflow:hidden;}",
    ".tm-live{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--tm-fg3);margin-bottom:8px;}",
    ".tm-live b{color:var(--tm-accent);font-variant-numeric:tabular-nums;font-weight:600;}",
    ".tm-hint{font-size:10px;color:var(--tm-fg3);opacity:.75;border-top:1px solid var(--tm-border);padding-top:7px;}",
    "@keyframes tm-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}",
    "@keyframes tm-bob-fast{0%,100%{transform:translateY(0) scale(1,1)}50%{transform:translateY(-6px) scale(.99,1.03)}}",
    "@keyframes tm-blink{0%,92%,100%{transform:scaleY(1)}96%{transform:scaleY(.12)}}",
    "@keyframes tm-look{0%,40%,100%{transform:translate(0,0)}48%,60%{transform:translate(1.4px,.6px)}68%,80%{transform:translate(-1.2px,.4px)}}",
    "@keyframes tm-tilt{0%,100%{transform:rotate(0)}30%,60%{transform:rotate(-5deg) translateY(-1px)}}",
    "@keyframes tm-spin{to{transform:rotate(360deg)}}",
    "@keyframes tm-chew{0%,100%{transform:scale(1,1)}50%{transform:scale(1.07,.92)}}",
    "@keyframes tm-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}",
    "@keyframes tm-jump{0%,100%{transform:translateY(0) scale(1,1)}30%{transform:translateY(-14px) scale(.96,1.06)}60%{transform:translateY(0) scale(1.04,.94)}}",
    "@keyframes tm-spout{0%{transform:translateY(2px);opacity:0}30%{opacity:.9}100%{transform:translateY(-6px);opacity:0}}",
    "@keyframes tm-spout-idle{0%,72%,100%{transform:translateY(2px);opacity:0}78%{opacity:.35}88%{transform:translateY(-5px);opacity:0}}",
    "@keyframes tm-shadow{0%,100%{transform:scale(1);opacity:.55}50%{transform:scale(.9);opacity:.4}}",
    "@keyframes tm-dot{0%,100%{transform:translateY(0);opacity:.45}50%{transform:translateY(-3px);opacity:1}}",
    "@keyframes tm-float-up{0%{transform:translateY(6px) scale(.7);opacity:0}25%{opacity:1}100%{transform:translateY(-38px) scale(1.15);opacity:0}}",
    "@keyframes tm-bump{0%{transform:scale(1)}35%{transform:scale(1.07);color:var(--tm-accent)}100%{transform:scale(1)}}",
    "@keyframes tm-plus{0%{transform:translateY(4px);opacity:0}20%{opacity:1}100%{transform:translateY(-26px);opacity:0}}",
    "@keyframes tm-pulse{0%,100%{opacity:1}50%{opacity:.45}}",
    "@keyframes tm-card-in{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}",
    "@keyframes tm-fade{0%,100%{opacity:.35}50%{opacity:1}}",
    "@media (prefers-reduced-motion: reduce){.tm-root *{animation:none!important;transition:none!important}}",
  ].join("\n");

  /* ══════════════════════════ 角色矢量 ══════════════════════════ */

/* 角色素材：用户提供的 Q 版表情包 → 本地抠图、去标签、压缩成 WebP data URI。
   状态映射：idle→眨眼、think→害羞、work→生气、eat→惊讶、happy→开心、error→难过。
   全部内嵌为 data URI（单文件、零外链、插件运行时不发网络请求）。 */
var PET_IMAGES = {
  idle: "data:image/webp;base64,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",
  think: "data:image/webp;base64,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",
  work: "data:image/webp;base64,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",
  eat: "data:image/webp;base64,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",
  happy: "data:image/webp;base64,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",
  error: "data:image/webp;base64,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",
};
var AVATAR_IMAGE = "data:image/webp;base64,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";
  /* ══════════════════════════ 小工具 ══════════════════════════ */

  function installStyles() {
    if (typeof document === "undefined") return;
    if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')) return;
    var tag = document.createElement("style");
    tag.dataset.plugin = PLUGIN_ID;
    tag.dataset.pluginCss = STYLE_ID;
    tag.textContent = CSS;
    (document.head || document.documentElement).appendChild(tag);
  }

  function warn(message, error) {
    try {
      console.warn("[dsh-token-mascot] " + message, error);
    } catch (_) {
      /* ignore */
    }
  }

  function readStoredJSON(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeStoredJSON(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* ignore */
    }
  }

  function petSize(cfg) {
    var size = num(cfg && cfg.size);
    return size >= 64 && size <= 220 ? size : DEFAULT_PET_SIZE;
  }

  function defaultPosition(cfg) {
    var width = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1280;
    var height = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 800;
    var size = petSize(cfg);
    return {
      x: Math.max(6, width - num(cfg.offsetX) - size),
      y: Math.max(6, height - num(cfg.offsetY) - size),
    };
  }

  function readPosition(cfg) {
    var stored = readStoredJSON(POS_KEY);
    var fallback = defaultPosition(cfg);
    if (!stored || typeof stored.x !== "number" || typeof stored.y !== "number") return fallback;
    var width = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1280;
    var height = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 800;
    var size = petSize(cfg);
    if (!isFinite(stored.x) || !isFinite(stored.y)) return fallback;
    return {
      x: clamp(stored.x, 4, Math.max(4, width - size - 4)),
      y: clamp(stored.y, 4, Math.max(4, height - size - 4)),
    };
  }

  function normalizeConfig(config) {
    var raw = (config && (config.mascot || config)) || {};
    var accent = typeof raw.accent === "string" && raw.accent ? raw.accent : "#4d93f8";
    return {
      collapsed: raw.collapsed !== undefined ? !!raw.collapsed : false,
      showLiveEstimate: raw.showLiveEstimate !== undefined ? !!raw.showLiveEstimate : true,
      showContext: raw.showContext !== undefined ? !!raw.showContext : true,
      showTask: raw.showTask !== undefined ? !!raw.showTask : true,
      showToday: raw.showToday !== undefined ? !!raw.showToday : true,
      size: typeof raw.size === "number" && raw.size >= 64 && raw.size <= 220 ? Math.round(raw.size) : DEFAULT_PET_SIZE,
      offsetX: typeof raw.offsetX === "number" ? raw.offsetX : 18,
      offsetY: typeof raw.offsetY === "number" ? raw.offsetY : 104,
      accent: accent,
    };
  }

  /* ══════════════════════════ React 侧 ══════════════════════════ */

  /**
   * 订阅会话事件窗口里的流式片段，产出「本步实时估算」。
   * 只依赖注入的 sessions 服务；拿不到 binding 或 eventSource 时返回空值并静默降级。
   */
  function useLiveSession(sessionsService, sessionId) {
    var React = window.__TM_REACT__;
    var state = React.useState(function () {
      return { attemptId: null, chars: 0, cjk: 0, other: 0, tokens: 0, tool: false };
    });
    var live = state[0];
    var setLive = state[1];

    React.useEffect(
      function () {
        if (!sessionsService || !sessionId || typeof sessionsService.binding !== "function") return undefined;
        var binding = null;
        try {
          binding = sessionsService.binding(sessionId);
        } catch (_) {
          return undefined;
        }
        var eventSource = binding && binding.eventSource;
        if (!eventSource || typeof eventSource.subscribe !== "function" || typeof eventSource.getSnapshot !== "function") {
          return undefined;
        }

        var scheduled = false;
        var timer = null;
        function flush() {
          scheduled = false;
          var next;
          try {
            var snapshot = eventSource.getSnapshot();
            next = computeLiveStream(snapshot && snapshot.entries);
          } catch (_) {
            return;
          }
          setLive(function (prev) {
            if (
              prev.attemptId === next.attemptId &&
              prev.chars === next.chars &&
              prev.tool === next.tool
            ) {
              return prev;
            }
            return next;
          });
        }
        function schedule() {
          if (scheduled) return;
          scheduled = true;
          if (typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(flush);
          } else {
            timer = window.setTimeout(flush, 90);
          }
        }

        var dispose = null;
        try {
          dispose = eventSource.subscribe(schedule);
        } catch (error) {
          warn("订阅流式事件失败，实时估算已关闭：", error);
          return undefined;
        }
        flush();
        return function () {
          if (timer) window.clearTimeout(timer);
          try {
            if (typeof dispose === "function") dispose();
          } catch (_) {
            /* ignore */
          }
        };
      },
      [sessionsService, sessionId],
    );

    return live;
  }

  /** 旧版 DSH 没有全局 useSessions hook 时的空实现：保住 hook 调用顺序。 */
  function noopSessions() {
    return undefined;
  }

  /**
   * 今日全部会话的 token 合计。
   *
   * 数据来源（全部走 DSH 公开面）：
   *   - 根作用域标准 hook `useSessions`：会话列表（含 updatedAt）与已加载的投影；
   *   - 注入的 `ctx.sessions.refreshProjections(id)`：按需把今日活跃会话的投影读进来。
   *
   * 口径说明：DSH 的 `tokenUsage` 投影是「会话级累计」，没有按天切分。所以这里在当天第一次
   * 看到某个会话时记下它的累计值作为「今日基准」，之后用「当前累计 - 基准」得到今天新增；
   * 0 点会重新取基准（页面一直开着也会重置）。升级/当天首次打开时，已有累计会被当作基准，
   * 所以今日计数从那一刻开始——之前当天已经消耗的部分无法回填。
   * 旧版 DSH 没有 useSessions 时返回 null，界面自动隐藏这一行。
   */
  function useTodayUsage(props) {
    var React = window.__TM_REACT__;
    var sessionsService = props.__sessions;
    var useSessions = props.useSessions;
    var requestedRef = React.useRef(null);
    if (requestedRef.current === null) requestedRef.current = {};
    var dayStart = startOfLocalDay();
    var dayKey = localDayKey();
    /* 跨过 0 点后重新按新的一天加载各会话投影（旧 day 的缓存值可能已过期）。 */
    var dayRef = React.useRef(dayStart);
    if (dayRef.current !== dayStart) {
      dayRef.current = dayStart;
      requestedRef.current = {};
    }
    var baselineRef = React.useRef(null);
    if (baselineRef.current === null || baselineRef.current.day !== dayKey) {
      baselineRef.current = readTodayBaseline(dayKey);
    }
    var baseline = baselineRef.current;
    var baselineDirty = false;

    /* 0 点强制重渲染一次：让「今日基准」在新的一天重新建立（页面空闲时也会触发）。 */
    var dayTickState = React.useState(0);
    var bumpDay = dayTickState[1];
    React.useEffect(
      function () {
        var now = Date.now();
        var next = new Date(now);
        next.setHours(24, 0, 0, 0);
        var delay = Math.max(1000, next.getTime() - now + 200);
        var timer = setTimeout(function () {
          bumpDay(function (value) {
            return value + 1;
          });
        }, delay);
        return function () {
          clearTimeout(timer);
        };
      },
      [dayKey],
    );
    var selectAll = function (state) {
      return state;
    };
    /* 无论新旧宿主都只调用一个函数：旧宿主用 noopSessions，保持 hook 数量稳定。 */
    var sessionsHook = typeof useSessions === "function" ? useSessions : noopSessions;
    var list = sessionsHook(selectAll);
    var rows = [];
    if (list && Array.isArray(list.ids)) {
      var byId = list.byId || {};
      for (var k = 0; k < list.ids.length; k += 1) {
        var candidate = byId[list.ids[k]];
        if (candidate) rows.push(candidate);
      }
    } else if (list && Array.isArray(list.items)) {
      rows = list.items;
    }
    var projections = list && list.projectionsBySession ? list.projectionsBySession : {};

    React.useEffect(
      function () {
        if (!sessionsService || typeof sessionsService.refreshProjections !== "function") return undefined;
        var requested = requestedRef.current;
        for (var i = 0; i < rows.length; i += 1) {
          var entry = rows[i];
          if (!entry || typeof entry.id !== "string" || entry.blank) continue;
          if (!(typeof entry.updatedAt === "number" && entry.updatedAt >= dayStart)) continue;
          if (requested[entry.id]) continue;
          requested[entry.id] = true;
          try {
            var pending = sessionsService.refreshProjections(entry.id);
            if (pending && typeof pending.catch === "function") {
              /* 单个会话的投影读失败只影响今日合计，静默降级 */
              pending.catch(function () {});
            }
          } catch (_) {
            /* ignore */
          }
        }
        return undefined;
      },
      [list, sessionsService, dayStart],
    );

    var usages = [];
    var details = [];
    var loading = 0;
    for (var j = 0; j < rows.length; j += 1) {
      var row = rows[j];
      if (!row || row.blank) continue;
      if (!(typeof row.updatedAt === "number" && row.updatedAt >= dayStart)) continue;
      var stored = projections[row.id];
      var usage = stored && stored.values ? stored.values.tokenUsage : undefined;
      if (usage === undefined) {
        loading += 1;
        continue;
      }
      var current = usageBucketsOf(usage);
      var base = baseline.sessions[row.id];
      if (base === undefined || usageBucketTotal(current) < usageBucketTotal(base)) {
        /* 今天第一次看到这个会话（或计数被重置）：记下当前累计作为今日基准。 */
        baseline.sessions[row.id] = current;
        base = current;
        baselineDirty = true;
      }
      var delta = subtractUsageBuckets(usage, base);
      var rowTotals = usageTotals(delta);
      if (rowTotals.total > 0) {
        usages.push(delta);
        details.push({
          id: row.id,
          title: row.displayTitle || row.title || "",
          total: rowTotals.total,
          current: row.id === props.sessionId,
        });
      }
    }
    if (baselineDirty) writeTodayBaseline(baseline);
    details.sort(function (left, right) {
      return right.total - left.total;
    });
    var sum = sumUsageBuckets(usages);
    sum.loading = loading;
    sum.available = typeof useSessions === "function";
    sum.details = details;
    return sum;
  }

  /** 把 usage 投影转换成卡片/角色需要的全部派生量。 */
  function useDerivedData(props, cfg) {
    var React = window.__TM_REACT__;
    var useProjection = props.useProjection;
    var useSession = props.useSession;

    var usage = typeof useProjection === "function" ? useProjection("tokenUsage") : undefined;
    var pressure = typeof useProjection === "function" ? useProjection("contextPressure") : undefined;
    var stats = typeof useProjection === "function" ? useProjection("sessionStats") : undefined;
    var todos = typeof useProjection === "function" ? useProjection("todos") : undefined;
    /* DSH 0.2.1-rc.3 起 useSession 是「选择器 hook」：必须传 selector（官方写法
       见 ui-chat 的 useSession((s) => s.running)）。旧版可直接 useSession() 取快照，
       在 rc.3 上会抛 "selector is not a function"，整个插槽条目崩溃 —— 表现就是
       「插件显示运行中，但右下角什么都不出现」。恒等选择器兼容两代契约。 */
    var selectSession = function (current) {
      return current;
    };
    var session = typeof useSession === "function" ? useSession(selectSession) : undefined;
    var today = useTodayUsage(props);

    var live = useLiveSession(props.__sessions, props.sessionId);
    var totals = usageTotals(usage);
    var context = cfg.showContext ? contextOccupancy(pressure) : null;
    var task = cfg.showTask ? pickTask(todos, session, live) : "";

    /* 本步实时速率：滑动增量（未结算，仅供动画与「约」读数） */
    var rateRef = React.useRef({ attemptId: null, time: 0, tokens: 0, rate: 0 });
    React.useEffect(
      function () {
        var now = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
        var previous = rateRef.current;
        if (previous.attemptId !== live.attemptId) {
          previous.attemptId = live.attemptId;
          previous.time = now;
          previous.tokens = live.tokens;
          previous.rate = 0;
          return;
        }
        var elapsed = (now - previous.time) / 1000;
        if (elapsed > 0.12 && live.tokens > previous.tokens) {
          var instant = (live.tokens - previous.tokens) / elapsed;
          previous.rate = previous.rate > 0 ? previous.rate * 0.65 + instant * 0.35 : instant;
          previous.time = now;
          previous.tokens = live.tokens;
        } else if (elapsed > 2) {
          previous.time = now;
          previous.tokens = live.tokens;
          previous.rate = previous.rate * 0.5;
        }
      },
      [live.attemptId, live.tokens],
    );

    var settledRate = 0;
    if (stats && num(stats.decodeMs) > 0 && num(stats.decodeTokens) > 0) {
      settledRate = (num(stats.decodeTokens) / num(stats.decodeMs)) * 1000;
    }
    var liveRate = session && session.running ? rateRef.current.rate : 0;
    var rate = liveRate > 0 ? liveRate : settledRate;

    return {
      usage: totals,
      rawUsage: usage,
      context: context,
      task: task,
      session: session,
      live: live,
      rate: rate,
      cacheHit: cacheHitPercent(usage),
      working: hasRunningTodo(todos),
      today: cfg.showToday ? today : null,
    };
  }

  /** 数字变化时的 +N 气泡与 bump 动画。 */
  function useDeltaPulse(total) {
    var React = window.__TM_REACT__;
    var state = React.useState({ delta: 0, seq: 0 });
    var pulse = state[0];
    var setPulse = state[1];
    var previousRef = React.useRef(null);
    var timerRef = React.useRef(null);

    React.useEffect(
      function () {
        var previous = previousRef.current;
        previousRef.current = total;
        if (previous === null || total <= previous) return;
        var delta = total - previous;
        if (delta <= 0) return;
        setPulse(function (prev) {
          return { delta: delta, seq: prev.seq + 1 };
        });
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(function () {
          setPulse(function (prev) {
            return { delta: 0, seq: prev.seq };
          });
        }, 1200);
        return function () {
          /* 保留 timer，由下一次变化或卸载清理 */
        };
      },
      [total],
    );

    React.useEffect(
      function () {
        return function () {
          if (timerRef.current) window.clearTimeout(timerRef.current);
        };
      },
      [],
    );

    return pulse;
  }

  var EMPTY_CTX_PROPS = {};

  function MascotAnchor(props) {
    var React = window.__TM_REACT__;
    var ReactDOM = window.__TM_REACT_DOM__;
    var cfg = props.__cfg || normalizeConfig(null);
    var body = typeof document !== "undefined" ? document.body : null;

    var anchor = React.createElement("span", {
      "data-token-mascot-anchor": "",
      "aria-hidden": "true",
      style: { display: "none" },
    });

    if (!body || !ReactDOM || typeof ReactDOM.createPortal !== "function") return anchor;

    return React.createElement(
      React.Fragment,
      null,
      anchor,
      ReactDOM.createPortal(
        React.createElement(TokenMascot, Object.assign({}, props, { __cfg: cfg })),
        body,
      ),
    );
  }

  function TokenMascot(props) {
    var React = window.__TM_REACT__;
    var cfg = props.__cfg || normalizeConfig(null);
    var derived = useDerivedData(props, cfg);
    var pulse = useDeltaPulse(derived.usage.total);

    var openState = React.useState(function () {
      var stored = readStoredJSON(OPEN_KEY);
      if (stored === true || stored === false) return stored;
      return !cfg.collapsed;
    });
    var open = openState[0];
    var setOpen = openState[1];

    /* 今日明细默认收起；点「今日 · 全部会话」展开各会话消耗。 */
    var todayOpenState = React.useState(false);
    var todayOpen = todayOpenState[0];
    var setTodayOpen = todayOpenState[1];

    var posState = React.useState(function () {
      return readPosition(cfg);
    });
    var pos = posState[0];
    var setPos = posState[1];

    var dragRef = React.useRef(null);
    var [justFinished, setJustFinished] = React.useState(false);
    var runningRef = React.useRef(false);
    var finishTimerRef = React.useRef(null);

    React.useEffect(
      function () {
        var running = !!(derived.session && derived.session.running);
        if (runningRef.current && !running) {
          setJustFinished(true);
          if (finishTimerRef.current) window.clearTimeout(finishTimerRef.current);
          finishTimerRef.current = window.setTimeout(function () {
            setJustFinished(false);
          }, 1700);
        }
        runningRef.current = running;
        return function () {
          /* timer 由下一次翻转或卸载清理 */
        };
      },
      [derived.session && derived.session.running],
    );

    React.useEffect(
      function () {
        return function () {
          if (finishTimerRef.current) window.clearTimeout(finishTimerRef.current);
        };
      },
      [],
    );

    React.useEffect(
      function () {
        writeStoredJSON(OPEN_KEY, open);
      },
      [open],
    );

    var error = !!(derived.session && derived.session.lastAgentError);
    var mood = deriveMascotState({
      session: derived.session,
      live: derived.live,
      error: error,
      working: derived.working,
      justFinished: justFinished,
    });

    var onPointerDown = function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: pos.x,
        originY: pos.y,
        moved: false,
        pointerId: event.pointerId,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch (_) {
        /* ignore */
      }
    };

    var onPointerMove = function (event) {
      var drag = dragRef.current;
      if (!drag) return;
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
      if (!drag.moved) return;
      var width = window.innerWidth || 1280;
      var height = window.innerHeight || 800;
      var size = petSize(cfg);
      setPos({
        x: clamp(drag.originX + dx, 4, Math.max(4, width - size - 4)),
        y: clamp(drag.originY + dy, 4, Math.max(4, height - size - 4)),
      });
    };

    var finishDrag = function (event, cancelled) {
      var drag = dragRef.current;
      dragRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch (_) {
        /* ignore */
      }
      if (!drag) return;
      if (drag.moved) {
        writeStoredJSON(POS_KEY, pos);
      } else if (!cancelled) {
        setOpen(function (value) {
          return !value;
        });
      }
    };

    var onClose = function () {
      setOpen(false);
    };

    var statusText = error ? "异常" : derived.session && derived.session.running ? "运行中" : "待命";
    var statusClass = error ? "tm-err" : derived.session && derived.session.running ? "tm-on" : "";

    var card = null;
    if (open) {
      var totals = derived.usage;
      var context = derived.context;
      var circumference = 2 * Math.PI * 9;
      var ringOffset = context ? circumference * (1 - context.percent / 100) : circumference;

      var rateText =
        derived.session && derived.session.running
          ? derived.rate > 0
            ? "≈" + derived.rate.toFixed(1) + " tok/s"
            : "生成中…"
          : derived.rate > 0
            ? derived.rate.toFixed(1) + " tok/s"
            : "—";

      var cacheText = derived.cacheHit === null ? "—" : derived.cacheHit + "%";

      card = React.createElement(
        "div",
        {
          className: "tm-card" + (pos.x < 340 ? " tm-left" : ""),
          role: "region",
          "aria-label": "小汪",
        },
        React.createElement(
          "div",
          { className: "tm-head" },
          React.createElement(
            "span",
            { className: "tm-avatar", "aria-hidden": "true" },
            React.createElement("img", {
              className: "tm-avatar-img",
              src: AVATAR_IMAGE,
              alt: "",
              draggable: false,
            }),
          ),
          React.createElement("span", { className: "tm-title" }, "小汪"),
          React.createElement(
            "span",
            { className: "tm-state" },
            React.createElement("i", { className: "tm-state-dot " + statusClass }),
            statusText,
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "tm-close",
              "aria-label": "收起",
              onClick: onClose,
            },
            "×",
          ),
        ),
        React.createElement(
          "div",
          { className: "tm-total" },
          React.createElement(
            "span",
            { key: pulse.seq, className: "tm-total-num" + (pulse.seq > 0 ? " tm-bump" : "") },
            formatExact(totals.total),
          ),
          React.createElement("span", { className: "tm-total-unit" }, "tokens"),
        React.createElement("span", { className: "tm-total-cn" }, formatCn(totals.total)),
          pulse.delta > 0
            ? React.createElement("span", { key: "plus-" + pulse.seq, className: "tm-plus" }, "+" + formatTokens(pulse.delta))
            : null,
        ),
        React.createElement(
          "div",
          { className: "tm-sub" },
          React.createElement("span", null, rateText),
          React.createElement("span", null, "缓存命中 " + cacheText),
        ),
        derived.today && derived.today.available
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "tm-today" + (todayOpen ? " tm-today-open" : ""),
                  "aria-expanded": todayOpen,
                  onClick: function () {
                    setTodayOpen(!todayOpen);
                  },
                  title:
                    "今日新增（相对今天首次看到时的增量，含本会话与子会话）：" +
                    formatExact(derived.today.total) +
                    " tokens · " +
                    derived.today.sessions +
                    " 个会话" +
                    "（输入 " +
                    formatExact(derived.today.uncached) +
                    " · 缓存读 " +
                    formatExact(derived.today.cacheRead) +
                    " · 输出 " +
                    formatExact(derived.today.output) +
                    "）",
                },
                React.createElement(
                  "span",
                  { className: "tm-today-icon", "aria-hidden": "true" },
                  React.createElement(
                    "svg",
                    { viewBox: "0 0 16 16", width: 13, height: 13, fill: "none" },
                    React.createElement("rect", {
                      x: 2.5,
                      y: 3.5,
                      width: 11,
                      height: 9.5,
                      rx: 2,
                      stroke: "currentColor",
                      strokeWidth: 1.2,
                    }),
                    React.createElement("path", {
                      d: "M5 2v3M11 2v3M2.5 7h11",
                      stroke: "currentColor",
                      strokeWidth: 1.2,
                      strokeLinecap: "round",
                    }),
                  ),
                ),
                React.createElement("span", { className: "tm-today-label" }, "今日 · 全部会话"),
                React.createElement("span", { className: "tm-today-sub" }, derived.today.sessions + " 个"),
                React.createElement(
                  "b",
                  { className: derived.today.loading > 0 && derived.today.sessions === 0 ? "tm-today-loading" : "" },
                  derived.today.loading > 0 && derived.today.sessions === 0
                    ? "…"
                    : formatTokens(derived.today.total) + (derived.today.loading > 0 ? "+" : ""),
                ),
                derived.today.loading > 0 && derived.today.sessions === 0
                  ? null
                  : React.createElement("span", { className: "tm-today-cn" }, formatCn(derived.today.total)),
                React.createElement("span", { className: "tm-today-chev", "aria-hidden": "true" }, "▾"),
              ),
              React.createElement(
                "div",
                {
                  className: "tm-today-list-wrap" + (todayOpen ? " tm-open" : ""),
                  "aria-hidden": todayOpen ? undefined : "true",
                },
                React.createElement(
                  "div",
                  { className: "tm-today-list-inner" },
                  React.createElement(
                    "div",
                    { className: "tm-today-list" },
                    derived.today.details && derived.today.details.length > 0
                      ? derived.today.details.map(function (item) {
                          return React.createElement(
                            "div",
                            {
                              className: "tm-today-item" + (item.current ? " tm-current" : ""),
                              key: item.id,
                              title: formatExact(item.total) + " tokens",
                            },
                            React.createElement(
                              "span",
                              { className: "tm-today-item-title" },
                              item.title || "未命名会话",
                            ),
                            item.current
                              ? React.createElement("span", { className: "tm-today-item-tag" }, "本会话")
                              : null,
                            React.createElement(
                              "span",
                              { className: "tm-today-item-value" },
                              formatCn(item.total),
                            ),
                          );
                        })
                      : React.createElement(
                          "div",
                          { className: "tm-today-empty" },
                          derived.today.loading > 0 ? "正在加载会话明细…" : "今日暂无消耗",
                        ),
                  ),
                ),
              ),
            )
          : null,
        cfg.showTask
          ? React.createElement(
              "div",
              { className: "tm-task" },
              React.createElement(
                "span",
                { className: "tm-task-icon", "aria-hidden": "true" },
                React.createElement(
                  "svg",
                  { viewBox: "0 0 16 16", width: 13, height: 13, fill: "none" },
                  React.createElement("path", {
                    d: "M8 1.6l1.5 3.4 3.7.4-2.8 2.5.8 3.6L8 9.6l-3.2 1.9.8-3.6L2.8 5.4l3.7-.4L8 1.6z",
                    stroke: "currentColor",
                    strokeWidth: 1.3,
                    strokeLinejoin: "round",
                  }),
                ),
              ),
              React.createElement("span", { className: "tm-task-text" }, derived.task),
            )
          : null,
        cfg.showLiveEstimate && derived.session && derived.session.running
          ? React.createElement(
              "div",
              { className: "tm-live" },
              React.createElement("span", null, "本步实时估算"),
              React.createElement("b", null, "≈" + formatTokens(derived.live.tokens)),
              derived.live.tool ? React.createElement("span", null, "· 工具参数生成中") : null,
            )
          : null,
        context
          ? React.createElement(
              "div",
              { className: "tm-meter tm-meter-bottom" },
              React.createElement(
                "svg",
                { className: "tm-ring", viewBox: "0 0 24 24", "aria-hidden": "true" },
                React.createElement("circle", { className: "tm-ring-track", cx: 12, cy: 12, r: 9 }),
                React.createElement("circle", {
                  className: "tm-ring-fill",
                  cx: 12,
                  cy: 12,
                  r: 9,
                  style: {
                    strokeDasharray: String(circumference),
                    strokeDashoffset: String(ringOffset),
                  },
                }),
              ),
              React.createElement(
                "div",
                { className: "tm-meter-main" },
                React.createElement(
                  "div",
                  { className: "tm-meter-top" },
                  React.createElement("span", { className: "tm-meter-pct" }, context.percent + "%"),
                  React.createElement(
                    "span",
                    { className: "tm-meter-cap" },
                    formatTokens(context.used) + " / " + formatTokens(context.window),
                  ),
                ),
                React.createElement(
                  "div",
                  { className: "tm-meter-bar" },
                  React.createElement("span", {
                    className: "tm-meter-seg",
                    style: { width: Math.max(2, context.percent) + "%" },
                  }),
                ),
              ),
            )
          : null,
        React.createElement("div", { className: "tm-hint" }, "拖拽移动 · 点小汪展开 / 收起"),
      );
    }

    var sparks = [];
    if (pulse.delta > 0) {
      for (var i = 0; i < 5; i += 1) {
        sparks.push(
          React.createElement("span", {
            key: "spark-" + pulse.seq + "-" + i,
            className: "tm-spark",
            style: { left: 14 + i * 8 + "px", animationDelay: i * 0.045 + "s" },
          }),
        );
      }
    }

    return React.createElement(
      "div",
      {
        className: "tm-root",
        "data-mood": mood,
        style: {
          left: pos.x + "px",
          top: pos.y + "px",
          width: petSize(cfg) + "px",
          height: petSize(cfg) + "px",
          "--tm-accent": cfg.accent,
        },
      },
      card,
      React.createElement(
        "button",
        {
          type: "button",
          className: "tm-pet",
          "aria-label": "小汪：" + formatExact(derived.usage.total) + " tokens，" + derived.task,
          "aria-expanded": open,
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: function (event) {
            finishDrag(event, false);
          },
          onPointerCancel: function (event) {
            finishDrag(event, true);
          },
        },
        React.createElement(
          "span",
          { className: "tm-pet-svg tm-svg-" + mood, "aria-hidden": "true" },
          React.createElement("img", {
            className: "tm-pet-img",
            src: PET_IMAGES[mood] || PET_IMAGES.idle,
            alt: "",
            draggable: false,
          }),
        ),
        React.createElement("span", { className: "tm-badge" }, formatTokens(derived.usage.total)),
        React.createElement(
          "span",
          { className: "tm-dots", "aria-hidden": "true" },
          React.createElement("i"),
          React.createElement("i"),
          React.createElement("i"),
        ),
      ),
      sparks.length > 0 ? React.createElement("span", { "aria-hidden": "true" }, sparks) : null,
    );
  }

  /* ══════════════════════════ 入口 ══════════════════════════ */

  window.__ModuleLoader__.load({
    id: "dsh-token-mascot",
    factory: function (require) {
      var React = require("react");
      var ReactDOM = require("react-dom");
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      /* 本包的浏览器侧模块把 React 句柄放在窗口上，供上面的组件函数使用。
         只在本模块初始化时写入一次；不同插件各用各的 key，不污染宿主。 */
      window.__TM_REACT__ = React;
      window.__TM_REACT_DOM__ = ReactDOM;

      function apply(ctx, config) {
        var cfg = normalizeConfig(config);
        try {
          installStyles();
        } catch (error) {
          warn("样式注入失败（界面可能无样式）：", error);
        }
        try {
          if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
            warn("没有 slots 服务，小汪不会出现");
            return;
          }
          ctx.slots.inject(SLOT_NAME, function () {
            return ctx.slots.register(
              {
                name: SLOT_NAME,
                id: PLUGIN_ID,
                order: 850,
                label: function () {
                  return "小汪";
                },
                inject: function (sessionId) {
                  return { sessionId: sessionId };
                },
              },
              function SlotComponent(props) {
                return React.createElement(
                  MascotAnchor,
                  Object.assign({}, props, { __cfg: cfg, __sessions: ctx.sessions }),
                );
              },
            );
          });
        } catch (error) {
          /* 注册失败只意味着右下角不出现小汪，绝不能连累宿主 */
          warn("插槽注册失败，小汪不会出现：", error);
        }
      }

      var inject = ["slots", "sessions"];

      exports.apply = apply;
      exports.inject = inject;
      exports.__internals = {
        SLOT_NAME: SLOT_NAME,
        CSS: CSS,
        PET_IMAGES: PET_IMAGES,
        AVATAR_IMAGE: AVATAR_IMAGE,
        countText: countText,
        estimateTokens: estimateTokens,
        computeLiveStream: computeLiveStream,
        formatTokens: formatTokens,
        formatExact: formatExact,
        clampPercent: clampPercent,
        usageTotals: usageTotals,
        cacheHitPercent: cacheHitPercent,
        contextOccupancy: contextOccupancy,
        startOfLocalDay: startOfLocalDay,
        sumUsageBuckets: sumUsageBuckets,
        deriveMascotState: deriveMascotState,
        pickTask: pickTask,
      };
      return module.exports;
    },
  });
})();
