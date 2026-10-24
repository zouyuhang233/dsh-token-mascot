// 从 plugin/lib/client.js 抽出 CSS，并用 preview/sprites-data.json 里的角色图，
// 生成一个可离线打开的预览页。
// 用法：node preview/build-preview.mjs   → 产出 preview/preview.html
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, "..", "plugin", "lib", "client.js");
const source = fs.readFileSync(clientPath, "utf8");
const sprites = JSON.parse(fs.readFileSync(path.join(here, "sprites-data.json"), "utf8"));

function extractBetween(startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`找不到 ${label} 起点：${startMarker}`);
  const from = start + startMarker.length;
  const end = source.indexOf(endMarker, from);
  if (end < 0) throw new Error(`找不到 ${label} 终点：${endMarker}`);
  return source.slice(from, end);
}

const cssArraySource = extractBetween("var CSS = ", "].join(\"\\n\");", "CSS") + "]";
const css = Function(`return (${cssArraySource})`)().join("\n");

const states = [
  ["idle", "待命 · 眨眼"],
  ["think", "思考 · 害羞"],
  ["work", "执行工具 · 生气"],
  ["eat", "吃 token · 惊讶"],
  ["happy", "完成 · 开心"],
  ["error", "出错 · 难过"],
];

const mockPets = states
  .map(
    ([state, label]) =>
      `<figure class="demo"><div class="tm-root demo-root" data-mood="${state}"><button class="tm-pet" type="button" aria-label="${label}"><span class="tm-pet-svg tm-svg-${state}"><img class="tm-pet-img" src="${sprites[state]}" alt="${label}"></span><span class="tm-badge">${state === "idle" ? "1.2k" : "12.4k"}</span><span class="tm-dots"><i></i><i></i><i></i></span></button></div><figcaption>${label}</figcaption></figure>`,
  )
  .join("\n");

const card = `
<div class="tm-root demo-card-root">
  <div class="tm-card demo-card">
    <div class="tm-head">
      <span class="tm-avatar"><img class="tm-avatar-img" src="${sprites.avatar}" alt=""></span>
      <span class="tm-title">小汪</span>
      <span class="tm-state"><i class="tm-state-dot tm-on"></i>运行中</span>
      <button type="button" class="tm-close" aria-label="收起">×</button>
    </div>
    <div class="tm-total">
      <span class="tm-total-num">1,284,391</span>
      <span class="tm-total-unit">tokens</span>
      <span class="tm-total-cn">128万</span>
      <span class="tm-plus">+1.2k</span>
    </div>
    <div class="tm-sub"><span>≈38.6 tok/s</span><span>缓存命中 72%</span></div>
    <button type="button" class="tm-today tm-today-open" title="点击展开今日各会话消耗：2,884,391 tokens · 3 个会话">
      <span class="tm-today-icon"><svg viewBox="0 0 16 16" width="13" height="13" fill="none"><rect x="2.5" y="3.5" width="11" height="9.5" rx="2" stroke="currentColor" stroke-width="1.2"></rect><path d="M5 2v3M11 2v3M2.5 7h11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path></svg></span>
      <span class="tm-today-label">今日 · 全部会话</span>
      <span class="tm-today-sub">3 个</span>
      <b>2.88M</b>
      <span class="tm-today-cn">288万</span>
      <span class="tm-today-chev">▾</span>
    </button>
    <div class="tm-today-list-wrap tm-open">
      <div class="tm-today-list-inner">
        <div class="tm-today-list">
          <div class="tm-today-item tm-current"><span class="tm-today-item-title">内容未显示问题排查</span><span class="tm-today-item-tag">本会话</span><span class="tm-today-item-value">128万</span></div>
          <div class="tm-today-item"><span class="tm-today-item-title">检查PCB是否符合题目要求</span><span class="tm-today-item-value">96万</span></div>
          <div class="tm-today-item"><span class="tm-today-item-title">修复问题</span><span class="tm-today-item-value">64万</span></div>
        </div>
      </div>
    </div>
    <div class="tm-task">
      <span class="tm-task-icon"><svg viewBox="0 0 16 16" width="13" height="13" fill="none"><path d="M8 1.6l1.5 3.4 3.7.4-2.8 2.5.8 3.6L8 9.6l-3.2 1.9.8-3.6L2.8 5.4l3.7-.4L8 1.6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path></svg></span>
      <span class="tm-task-text">正在做：实现 token 看板的实时面板</span>
    </div>
    <div class="tm-live"><span>本步实时估算</span><b>≈1.4k</b></div>
    <div class="tm-meter tm-meter-bottom">
      <svg class="tm-ring" viewBox="0 0 24 24" aria-hidden="true">
        <circle class="tm-ring-track" cx="12" cy="12" r="9"></circle>
        <circle class="tm-ring-fill" cx="12" cy="12" r="9" style="stroke-dasharray:56.55;stroke-dashoffset:37.89"></circle>
      </svg>
      <div class="tm-meter-main">
        <div class="tm-meter-top"><span class="tm-meter-pct">33%</span><span class="tm-meter-cap">335k / 1M</span></div>
        <div class="tm-meter-bar"><span class="tm-meter-seg" style="width:33%"></span></div>
      </div>
    </div>
    <div class="tm-hint">拖拽移动 · 点小汪展开 / 收起</div>
  </div>
</div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-token-mascot · 预览</title>
<style>
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    background: radial-gradient(1200px 800px at 20% 0%, #1b2333 0%, #0f1115 55%, #0b0d11 100%);
    color: #e8eaed;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 34px;
    padding: 46px 24px 60px;
  }
  h1 { font-size: 18px; font-weight: 600; letter-spacing: .08em; margin: 0; color: #cfd3d6; }
  h1 small { display: block; font-size: 11px; font-weight: 400; letter-spacing: .12em; color: #81858c; margin-top: 6px; }
  .stage { display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start; justify-content: center; }
  .demo { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .demo figcaption { font-size: 11px; color: #81858c; letter-spacing: .06em; }
  .demo-root { position: relative !important; left: auto !important; top: auto !important; width: 136px; height: 136px; display: flex; align-items: center; justify-content: center; }
  .demo-root .tm-pet { width: 128px; height: 128px; }
  .demo-root .tm-pet-img { height: 128px; }
  .card-stage { min-height: 400px; }
  .demo-card-root { position: relative !important; left: auto !important; top: auto !important; }
  .demo-card { position: relative !important; bottom: auto !important; right: auto !important; animation: none !important; }
  .note { max-width: 640px; font-size: 12px; line-height: 1.7; color: #81858c; text-align: center; }
  .note code { color: #adb2b8; background: rgba(255,255,255,.06); padding: 1px 5px; border-radius: 4px; }
</style>
<style>
${css}
</style>
</head>
<body>
  <h1>小汪<small>dsh-token-mascot · 状态与面板预览</small></h1>
  <div class="stage">${mockPets}</div>
  <div class="stage card-stage">${card}</div>
  <p class="note">此页由 <code>node preview/build-preview.mjs</code> 生成，CSS 与角色图（<code>preview/sprites/*.webp</code>）和插件产物同源。真实面板的数字来自 DSH 官方投影（tokenUsage / contextPressure / sessionStats / todos），「今日 · 全部会话」来自全局 useSessions + 各会话 tokenUsage 投影，运行状态来自会话事件流。</p>
</body>
</html>
`;

const out = path.join(here, "preview.html");
fs.writeFileSync(out, html, "utf8");
console.log(`已生成 ${out}（CSS ${css.length} 字符，角色 ${states.length} 个）`);
