/**
 * dsh-token-mascot — 宿主半边（零依赖、空逻辑）
 *
 * 这个插件的全部功能都在客户端半边（`lib/client.js`）。宿主半边存在的唯一理由是
 * 让这个包成为 cordis 树上的一行：`dsh.client` 的客户端 bundle 是靠「宿主 Loader 的
 * 条目里有这个包」被 `dsh-client-modules` 扫出来、编进 `window.__DSH_BOOT__` 的。
 * 没有宿主条目，客户端产物永远不会被加载。
 *
 * 三条纪律（沿用 DSH 生态里已被事故验证过的形状）：
 *   1. apply() 绝不抛错：同步抛错会让该条目的 fiber 失败，启动审计会把它报成
 *      「Failed to load plugins」。这里只做静态核对，且核对本身也包在 try/catch 里。
 *   2. inject 只声明确定存在的服务：本插件宿主半边不声明任何服务。
 *   3. 不打日志噪音：只在 bundle 缺失/损坏时告警一次 —— 那是唯一一种「插件装了但
 *      界面不会有东西」的宿主侧可观测故障。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_ID = "dsh-token-mascot";

/**
 * 静态核对客户端产物：只读文件、查关键标志，**不执行**产物。
 * 任何问题只告警，绝不阻断启动（这份产物坏了，坏的也只是右下角那只小汪）。
 */
function auditClientBundle(log) {
  try {
    const bundle = readFileSync(fileURLToPath(new URL("./client.js", import.meta.url)), "utf8");
    const problems = [];
    if (!bundle.includes(`id: "${PACKAGE_ID}"`) && !bundle.includes(`id:"${PACKAGE_ID}"`)) {
      problems.push("bundle id 不匹配");
    }
    if (!bundle.includes("__ModuleLoader__.load")) problems.push("不是模块加载器 bundle");
    if (!bundle.includes("return module.exports")) problems.push("工厂没有交出 exports");
    if (!bundle.includes("conversation.input.right")) problems.push("没有声明目标插槽");
    if (!/exports\.apply\s*=/.test(bundle)) problems.push("没有导出 apply");
    if (problems.length > 0) {
      log(`客户端产物 lib/client.js 检查未通过（右下角不会出现小汪）：${problems.join("；")}`);
      return;
    }
    log(`客户端产物 lib/client.js 就绪（${Buffer.byteLength(bundle, "utf8")} 字节，静态检查通过）`);
  } catch (error) {
    log(`客户端产物 lib/client.js 不可读（右下角不会出现小汪）：${String(error)}`);
  }
}

/**
 * @param ctx 宿主 cordis 上下文（本插件不使用它的任何能力）
 */
export function apply(ctx) {
  try {
    const candidate = ctx?.logger;
    const sink = typeof candidate === "function" ? candidate(PACKAGE_ID) : candidate;
    const log = (message) => {
      try {
        if (sink && typeof sink.info === "function") sink.info(`[${PACKAGE_ID}] ${message}`);
        else console.info(`[${PACKAGE_ID}] ${message}`);
      } catch {
        /* 连日志都不能抛 */
      }
    };
    auditClientBundle(log);
  } catch {
    /* 审计本身失败也必须让 apply 静默成功 */
  }
}

export default { apply };
