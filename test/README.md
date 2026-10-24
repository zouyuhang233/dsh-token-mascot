# dsh-token-mascot · 离线契约测试

本目录只做**只读**契约验证，不修改 `plugin/`，不安装任何依赖，不联网。

| 文件 | 作用 |
| --- | --- |
| `validate.mjs` | Node 静态契约校验：manifest / patch / 宿主侧 `import()` / 浏览器产物关键标志位 |
| `harness.html` | 浏览器端离线契约测试页：桩 `__ModuleLoader__` + 桩 React，跑 `load → factory(require) → apply(ctx)` 并直调纯函数 |

---

## 1. 静态校验 `validate.mjs`

```powershell
# 在插件根目录（dsh-token-mascot/）
node test/validate.mjs

# 或在 test/ 目录内
cd test
node validate.mjs
```

脚本内用 `import.meta.url` 自己定位插件根（`<repo>/plugin`），所以 **cwd 任意**。
若 PATH 里没有 `node`，用绝对路径：

```powershell
& "C:\Users\zyh\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" test/validate.mjs
```

输出约定：

- 每行 `PASS  <desc>` / `FAIL  <desc>（原因）`；
- 最后一行 `N passed, M failed`；
- 全通过 `exit 0`，任一失败 `exit 1`；
- 插件文件不存在、JSON 损坏、`import()` 失败都会变成可读的 `FAIL`，不会让脚本崩溃。

校验内容：

- `plugin/package.json`：`name`、`dsh.bundle.patch`（字符串/数组 → 实际存在的 `cordis.patch.yml`）、
  `dsh.client.platform === "web"`、`exports["./client"] → lib/client.js`、`main → lib/index.js`；
- `plugin/cordis.patch.yml`：包含 `insert:`、包含 `id: dsh-token-mascot`；
- `plugin/lib/index.js`：可被 `import()`、导出 `apply`、`apply()` 无参调用不抛错；
- `plugin/lib/client.js`：`__ModuleLoader__.load`、`id: "dsh-token-mascot"`、`exports.apply`、
  `conversation.input.right`、`require` 仅 `react` / `react-dom`、无 `fetch(` / `XMLHttpRequest` /
  `new WebSocket`、`exports.__internals` 存在且八个关键纯函数名出现；
- `client.js` 不得出现无参 `useSession()`（DSH 0.2.1-rc.3 起它是选择器 hook，必须传 selector）；
- `client.js` 用 `useSessions` + `ctx.sessions.refreshProjections` + `tokenUsage` 汇总今日全部会话。

> 严格点（有意保留，不为“跑绿”而放松）：
> - `id` 必须是**字面量** `id: "dsh-token-mascot"`（允许空格变体），写成 `id: PLUGIN_ID` 会 FAIL；
>   插件自己的 `plugin/lib/index.js` 静态审计也只认这个字面量。
> - `deriveMascotState` 的返回值按约定枚举 `idle / think / work / eat / happy / error` 断言。

---

## 2. 浏览器契约页 `harness.html`

**直接双击打开**即可（`file://` 可用，无服务器、无 CDN、无字体外链）。它按顺序做：

1. 安装桩：`window.__ModuleLoader__`、桩 React / ReactDOM（`createElement`、`Fragment`、hooks、
   `createPortal`、`Component` 等）、只认 `react` / `react-dom` 的 `require` 桩；
2. 以经典 `<script src="../plugin/lib/client.js">` 加载待测产物；
3. 用桩 `require` 调 `factory(require)`，再用假 `ctx.slots` 调 `apply(ctx)`；
4. 断言模块 id / factory / apply / inject、插槽注册（`conversation.input.right` + 插件 id + 组件函数）、
   `<style data-plugin-css>` 注入、`exports.__internals` 六个纯函数的输入输出；
5. 顶部显示总结果：全绿 `ALL PASS (n)`，有失败 `FAILED (m/n)`；列表逐项绿/红。

程序化读取（Console 或自动化脚本）：

```js
window.__summary   // { total, passed, failed, ok }
window.__results   // [{ name, ok, info }, ...]
window.__calls     // { load: [], require: [], registered: [], errors: [] }
window.__done      // 测试是否跑完
```

headless Chrome 快速验收（可选，PowerShell）：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --headless=new --disable-gpu --virtual-time-budget=4000 --dump-dom `
  "file:///C:/Users/zyh/Documents/deepseek-harness/default-workspace/dsh-token-mascot/test/harness.html" |
  Select-String 'id="summary"'
```

预期看到：

```html
<div id="summary" class="pass" role="status" aria-live="polite">ALL PASS (27)</div>
```

若看到 `script 加载失败` 或 `FAILED`：先确认 `plugin/lib/client.js` 已生成；
再看 `window.__calls.errors` / 红色条目的 `info`，里面会写明具体原因（例如缺 `__internals`、
样式未注入、注册的 def 字段不符）。页面不会修改插件或宿主，只读 DOM。

---

## 3. 已知边界

- `validate.mjs` 的 `require` 扫描是**静态文本**扫描：注释里写 `require("x")` 也会被计入。
- `harness.html` 只覆盖“模块契约 + 纯函数”，不渲染 React 组件、不模拟 DSH 的 projection /
  session 服务；组件内部交互属于宿主集成测试的范围。
- 两个脚本都假设插件根目录的上一级是 `test/`，即目录结构为
  `dsh-token-mascot/{plugin,test}`。
