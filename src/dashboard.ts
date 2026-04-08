import http from "node:http";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DASHBOARD_PORT, DB_PATH } from "./constants.ts";
import { calcCost, fmtCost, fmtCostBig } from "./costs.ts";
import { openDb } from "./db.ts";
import { scan } from "./scanner.ts";

type DashboardData = {
  all_models: string[];
  daily_by_model: Array<{
    day: string;
    model: string;
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
    turns: number;
  }>;
  sessions_all: Array<{
    session_id: string;
    project: string;
    last: string;
    last_date: string;
    duration_min: number;
    model: string;
    turns: number;
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  }>;
  generated_at: string;
  error?: string;
};

function toLocalTimestamp(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function getDashboardData(dbPath = DB_PATH): DashboardData {
  try {
    const db = openDb(dbPath);
    const modelRows = db.prepare(`
      SELECT COALESCE(model, 'unknown') AS model
      FROM turns
      GROUP BY model
      ORDER BY SUM(input_tokens + output_tokens) DESC
    `).all() as Array<{ model: string }>;

    const dailyRows = db.prepare(`
      SELECT
        substr(timestamp, 1, 10) AS day,
        COALESCE(model, 'unknown') AS model,
        SUM(input_tokens) AS input,
        SUM(output_tokens) AS output,
        SUM(cache_read_tokens) AS cache_read,
        SUM(cache_creation_tokens) AS cache_creation,
        COUNT(*) AS turns
      FROM turns
      GROUP BY day, model
      ORDER BY day, model
    `).all() as Array<Record<string, unknown>>;

    const sessionRows = db.prepare(`
      SELECT
        session_id, project_name, first_timestamp, last_timestamp,
        total_input_tokens, total_output_tokens,
        total_cache_read, total_cache_creation, model, turn_count
      FROM sessions
      ORDER BY last_timestamp DESC
    `).all() as Array<Record<string, unknown>>;

    const sessionsAll = sessionRows.map((row) => {
      let durationMin = 0;
      try {
        const start = new Date(String(row.first_timestamp ?? "").replace("Z", "+00:00"));
        const end = new Date(String(row.last_timestamp ?? "").replace("Z", "+00:00"));
        if (!Number.isNaN(start.valueOf()) && !Number.isNaN(end.valueOf())) {
          durationMin = Math.round(((end.valueOf() - start.valueOf()) / 60000) * 10) / 10;
        }
      } catch {
        durationMin = 0;
      }

      return {
        session_id: String(row.session_id ?? "").slice(0, 8),
        project: String(row.project_name ?? "unknown") || "unknown",
        last: String(row.last_timestamp ?? "").slice(0, 16).replace("T", " "),
        last_date: String(row.last_timestamp ?? "").slice(0, 10),
        duration_min: durationMin,
        model: String(row.model ?? "unknown") || "unknown",
        turns: Number(row.turn_count ?? 0),
        input: Number(row.total_input_tokens ?? 0),
        output: Number(row.total_output_tokens ?? 0),
        cache_read: Number(row.total_cache_read ?? 0),
        cache_creation: Number(row.total_cache_creation ?? 0)
      };
    });

    db.close();

    return {
      all_models: modelRows.map((row) => row.model),
      daily_by_model: dailyRows.map((row) => ({
        day: String(row.day ?? ""),
        model: String(row.model ?? "unknown"),
        input: Number(row.input ?? 0),
        output: Number(row.output ?? 0),
        cache_read: Number(row.cache_read ?? 0),
        cache_creation: Number(row.cache_creation ?? 0),
        turns: Number(row.turns ?? 0)
      })),
      sessions_all: sessionsAll,
      generated_at: toLocalTimestamp(new Date())
    };
  } catch {
    return { all_models: [], daily_by_model: [], sessions_all: [], generated_at: toLocalTimestamp(new Date()), error: "Database not found. Run: npm run scan" };
  }
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Code Usage Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0f1117;
    --card: #1a1d27;
    --border: #2a2d3a;
    --text: #e2e8f0;
    --muted: #8892a4;
    --accent: #d97757;
    --blue: #4f8ef7;
    --green: #4ade80;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; }
  header { background: var(--card); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 18px; font-weight: 600; color: var(--accent); }
  header .meta { color: var(--muted); font-size: 12px; }
  #filter-bar { background: var(--card); border-bottom: 1px solid var(--border); padding: 10px 24px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .filter-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); white-space: nowrap; }
  .filter-sep { width: 1px; height: 22px; background: var(--border); flex-shrink: 0; }
  #model-checkboxes { display: flex; flex-wrap: wrap; gap: 6px; }
  .model-cb-label { display: flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 20px; border: 1px solid var(--border); cursor: pointer; font-size: 12px; color: var(--muted); transition: border-color 0.15s, color 0.15s, background 0.15s; user-select: none; }
  .model-cb-label:hover { border-color: var(--accent); color: var(--text); }
  .model-cb-label.checked { background: rgba(217,119,87,0.12); border-color: var(--accent); color: var(--text); }
  .model-cb-label input { display: none; }
  .filter-btn { padding: 3px 10px; border-radius: 4px; border: 1px solid var(--border); background: transparent; color: var(--muted); font-size: 11px; cursor: pointer; white-space: nowrap; }
  .filter-btn:hover { border-color: var(--accent); color: var(--text); }
  .range-group { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; flex-shrink: 0; }
  .range-btn { padding: 4px 13px; background: transparent; border: none; border-right: 1px solid var(--border); color: var(--muted); font-size: 12px; cursor: pointer; transition: background 0.15s, color 0.15s; }
  .range-btn:last-child { border-right: none; }
  .range-btn:hover { background: rgba(255,255,255,0.04); color: var(--text); }
  .range-btn.active { background: rgba(217,119,87,0.15); color: var(--accent); font-weight: 600; }
  .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .stat-card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .stat-card .value { font-size: 22px; font-weight: 700; }
  .stat-card .sub { color: var(--muted); font-size: 11px; margin-top: 4px; }
  .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .chart-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
  .chart-card.wide { grid-column: 1 / -1; }
  .chart-card h2 { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px; }
  .chart-wrap { position: relative; height: 240px; }
  .chart-wrap.tall { height: 300px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); border-bottom: 1px solid var(--border); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .model-tag { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; background: rgba(79,142,247,0.15); color: var(--blue); }
  .cost { color: var(--green); font-family: monospace; }
  .cost-na { color: var(--muted); font-family: monospace; font-size: 11px; }
  .num { font-family: monospace; }
  .muted { color: var(--muted); }
  .section-title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
  .table-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 24px; overflow-x: auto; }
  footer { border-top: 1px solid var(--border); padding: 20px 24px; margin-top: 8px; }
  .footer-content { max-width: 1400px; margin: 0 auto; }
  .footer-content p { color: var(--muted); font-size: 12px; line-height: 1.7; margin-bottom: 4px; }
  .footer-content p:last-child { margin-bottom: 0; }
  .footer-content a { color: var(--blue); text-decoration: none; }
  .footer-content a:hover { text-decoration: underline; }
  @media (max-width: 768px) { .charts-grid { grid-template-columns: 1fr; } .chart-card.wide { grid-column: 1; } }
</style>
</head>
<body>
<header>
  <h1>Claude Code Usage Dashboard</h1>
  <div class="meta" id="meta">Loading...</div>
</header>
<div id="filter-bar">
  <div class="filter-label">Models</div>
  <div id="model-checkboxes"></div>
  <button class="filter-btn" onclick="selectAllModels()">All</button>
  <button class="filter-btn" onclick="clearAllModels()">None</button>
  <div class="filter-sep"></div>
  <div class="filter-label">Range</div>
  <div class="range-group">
    <button class="range-btn" data-range="7d" onclick="setRange('7d')">7d</button>
    <button class="range-btn" data-range="30d" onclick="setRange('30d')">30d</button>
    <button class="range-btn" data-range="90d" onclick="setRange('90d')">90d</button>
    <button class="range-btn" data-range="all" onclick="setRange('all')">All</button>
  </div>
</div>
<div class="container">
  <div class="stats-row" id="stats-row"></div>
  <div class="charts-grid">
    <div class="chart-card wide">
      <h2 id="daily-chart-title">Daily Token Usage</h2>
      <div class="chart-wrap tall"><canvas id="chart-daily"></canvas></div>
    </div>
    <div class="chart-card">
      <h2>By Model</h2>
      <div class="chart-wrap"><canvas id="chart-model"></canvas></div>
    </div>
    <div class="chart-card">
      <h2>Top Projects by Tokens</h2>
      <div class="chart-wrap"><canvas id="chart-project"></canvas></div>
    </div>
  </div>
  <div class="table-card">
    <div class="section-title">Recent Sessions</div>
    <table>
      <thead><tr>
        <th>Session</th><th>Project</th><th>Last Active</th><th>Duration</th>
        <th>Model</th><th>Turns</th><th>Input</th><th>Output</th><th>Est. Cost</th>
      </tr></thead>
      <tbody id="sessions-body"></tbody>
    </table>
  </div>
  <div class="table-card">
    <div class="section-title">Cost by Model</div>
    <table>
      <thead><tr>
        <th>Model</th><th>Turns</th><th>Input</th><th>Output</th>
        <th>Cache Read</th><th>Cache Creation</th><th>Est. Cost</th>
      </tr></thead>
      <tbody id="model-cost-body"></tbody>
    </table>
  </div>
</div>
<footer>
  <div class="footer-content">
    <p>Cost estimates based on Anthropic API pricing as of April 2026. Only billable Claude models are included in cost calculations.</p>
  </div>
</footer>
<script>
let rawData = null;
let selectedModels = new Set();
let selectedRange = '30d';
let charts = {};
const PRICING = {
  'claude-opus-4-6':   { input: 6.15,  output: 30.75, cache_write: 7.69, cache_read: 0.61 },
  'claude-opus-4-5':   { input: 6.15,  output: 30.75, cache_write: 7.69, cache_read: 0.61 },
  'claude-sonnet-4-6': { input: 3.69,  output: 18.45, cache_write: 4.61, cache_read: 0.37 },
  'claude-sonnet-4-5': { input: 3.69,  output: 18.45, cache_write: 4.61, cache_read: 0.37 },
  'claude-haiku-4-6':  { input: 1.23,  output: 6.15,  cache_write: 1.54, cache_read: 0.12 },
  'claude-haiku-4-5':  { input: 1.23,  output: 6.15,  cache_write: 1.54, cache_read: 0.12 },
};
function isBillable(model) {
  if (!model) return false;
  const m = model.toLowerCase();
  return m.includes('opus') || m.includes('sonnet') || m.includes('haiku');
}
function getPricing(model) {
  if (!model) return null;
  if (PRICING[model]) return PRICING[model];
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  const m = model.toLowerCase();
  if (m.includes('opus')) return PRICING['claude-opus-4-6'];
  if (m.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  if (m.includes('haiku')) return PRICING['claude-haiku-4-5'];
  return null;
}
function calcCost(model, inp, out, cacheRead, cacheCreation) {
  if (!isBillable(model)) return 0;
  const p = getPricing(model);
  if (!p) return 0;
  return inp * p.input / 1e6 + out * p.output / 1e6 + cacheRead * p.cache_read / 1e6 + cacheCreation * p.cache_write / 1e6;
}
function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}
function fmtCost(c) { return '$' + c.toFixed(4); }
function fmtCostBig(c) { return '$' + c.toFixed(2); }
const TOKEN_COLORS = {
  input: 'rgba(79,142,247,0.8)',
  output: 'rgba(167,139,250,0.8)',
  cache_read: 'rgba(74,222,128,0.6)',
  cache_creation: 'rgba(251,191,36,0.6)',
};
const MODEL_COLORS = ['#d97757','#4f8ef7','#4ade80','#a78bfa','#fbbf24','#f472b6','#34d399','#60a5fa'];
const RANGE_LABELS = { '7d': 'Last 7 Days', '30d': 'Last 30 Days', '90d': 'Last 90 Days', 'all': 'All Time' };
const RANGE_TICKS = { '7d': 7, '30d': 15, '90d': 13, 'all': 12 };
function getRangeCutoff(range) {
  if (range === 'all') return null;
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function readURLRange() {
  const p = new URLSearchParams(window.location.search).get('range');
  return ['7d', '30d', '90d', 'all'].includes(p) ? p : '30d';
}
function setRange(range) {
  selectedRange = range;
  document.querySelectorAll('.range-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.range === range));
  updateURL();
  applyFilter();
}
function modelPriority(m) {
  const ml = m.toLowerCase();
  if (ml.includes('opus')) return 0;
  if (ml.includes('sonnet')) return 1;
  if (ml.includes('haiku')) return 2;
  return 3;
}
function readURLModels(allModels) {
  const param = new URLSearchParams(window.location.search).get('models');
  if (!param) return new Set(allModels.filter(m => isBillable(m)));
  const fromURL = new Set(param.split(',').map(s => s.trim()).filter(Boolean));
  return new Set(allModels.filter(m => fromURL.has(m)));
}
function isDefaultModelSelection(allModels) {
  const billable = allModels.filter(m => isBillable(m));
  if (selectedModels.size !== billable.length) return false;
  return billable.every(m => selectedModels.has(m));
}
function buildFilterUI(allModels) {
  const sorted = [...allModels].sort((a, b) => {
    const pa = modelPriority(a), pb = modelPriority(b);
    return pa !== pb ? pa - pb : a.localeCompare(b);
  });
  selectedModels = readURLModels(allModels);
  const container = document.getElementById('model-checkboxes');
  container.innerHTML = sorted.map(m => {
    const checked = selectedModels.has(m);
    return '<label class="model-cb-label ' + (checked ? 'checked' : '') + '" data-model="' + m + '"><input type="checkbox" value="' + m + '" ' + (checked ? 'checked' : '') + ' onchange="onModelToggle(this)">' + m + '</label>';
  }).join('');
}
function onModelToggle(cb) {
  const label = cb.closest('label');
  if (cb.checked) { selectedModels.add(cb.value); label.classList.add('checked'); }
  else { selectedModels.delete(cb.value); label.classList.remove('checked'); }
  updateURL();
  applyFilter();
}
function selectAllModels() {
  document.querySelectorAll('#model-checkboxes input').forEach(cb => {
    cb.checked = true; selectedModels.add(cb.value); cb.closest('label').classList.add('checked');
  });
  updateURL(); applyFilter();
}
function clearAllModels() {
  document.querySelectorAll('#model-checkboxes input').forEach(cb => {
    cb.checked = false; selectedModels.delete(cb.value); cb.closest('label').classList.remove('checked');
  });
  updateURL(); applyFilter();
}
function updateURL() {
  const allModels = Array.from(document.querySelectorAll('#model-checkboxes input')).map(cb => cb.value);
  const params = new URLSearchParams();
  if (selectedRange !== '30d') params.set('range', selectedRange);
  if (!isDefaultModelSelection(allModels)) params.set('models', Array.from(selectedModels).join(','));
  const search = params.toString() ? '?' + params.toString() : '';
  history.replaceState(null, '', window.location.pathname + search);
}
function applyFilter() {
  if (!rawData) return;
  const cutoff = getRangeCutoff(selectedRange);
  const filteredDaily = rawData.daily_by_model.filter(r => selectedModels.has(r.model) && (!cutoff || r.day >= cutoff));
  const dailyMap = {};
  for (const r of filteredDaily) {
    if (!dailyMap[r.day]) dailyMap[r.day] = { day: r.day, input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    const d = dailyMap[r.day];
    d.input += r.input;
    d.output += r.output;
    d.cache_read += r.cache_read;
    d.cache_creation += r.cache_creation;
  }
  const daily = Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day));
  const modelMap = {};
  for (const r of filteredDaily) {
    if (!modelMap[r.model]) modelMap[r.model] = { model: r.model, input: 0, output: 0, cache_read: 0, cache_creation: 0, turns: 0, sessions: 0 };
    const m = modelMap[r.model];
    m.input += r.input;
    m.output += r.output;
    m.cache_read += r.cache_read;
    m.cache_creation += r.cache_creation;
    m.turns += r.turns;
  }
  const filteredSessions = rawData.sessions_all.filter(s => selectedModels.has(s.model) && (!cutoff || s.last_date >= cutoff));
  for (const s of filteredSessions) {
    if (modelMap[s.model]) modelMap[s.model].sessions++;
  }
  const byModel = Object.values(modelMap).sort((a, b) => (b.input + b.output) - (a.input + a.output));
  const projMap = {};
  for (const s of filteredSessions) {
    if (!projMap[s.project]) projMap[s.project] = { project: s.project, input: 0, output: 0, turns: 0 };
    projMap[s.project].input += s.input;
    projMap[s.project].output += s.output;
    projMap[s.project].turns += s.turns;
  }
  const byProject = Object.values(projMap).sort((a, b) => (b.input + b.output) - (a.input + a.output));
  const totals = {
    sessions: filteredSessions.length,
    turns: byModel.reduce((s, m) => s + m.turns, 0),
    input: byModel.reduce((s, m) => s + m.input, 0),
    output: byModel.reduce((s, m) => s + m.output, 0),
    cache_read: byModel.reduce((s, m) => s + m.cache_read, 0),
    cache_creation: byModel.reduce((s, m) => s + m.cache_creation, 0),
    cost: byModel.reduce((s, m) => s + calcCost(m.model, m.input, m.output, m.cache_read, m.cache_creation), 0),
  };
  document.getElementById('daily-chart-title').textContent = 'Daily Token Usage - ' + RANGE_LABELS[selectedRange];
  renderStats(totals);
  renderDailyChart(daily);
  renderModelChart(byModel);
  renderProjectChart(byProject);
  renderSessionsTable(filteredSessions.slice(0, 20));
  renderModelCostTable(byModel);
}
function renderStats(t) {
  const rangeLabel = RANGE_LABELS[selectedRange].toLowerCase();
  const stats = [
    { label: 'Sessions', value: t.sessions.toLocaleString(), sub: rangeLabel },
    { label: 'Turns', value: fmt(t.turns), sub: rangeLabel },
    { label: 'Input Tokens', value: fmt(t.input), sub: rangeLabel },
    { label: 'Output Tokens', value: fmt(t.output), sub: rangeLabel },
    { label: 'Cache Read', value: fmt(t.cache_read), sub: 'from prompt cache' },
    { label: 'Cache Creation', value: fmt(t.cache_creation), sub: 'writes to prompt cache' },
    { label: 'Est. Cost', value: fmtCostBig(t.cost), sub: 'API pricing, Apr 2026', color: '#4ade80' },
  ];
  document.getElementById('stats-row').innerHTML = stats.map(s => '<div class="stat-card"><div class="label">' + s.label + '</div><div class="value" style="' + (s.color ? 'color:' + s.color : '') + '">' + s.value + '</div>' + (s.sub ? '<div class="sub">' + s.sub + '</div>' : '') + '</div>').join('');
}
function renderDailyChart(daily) {
  const ctx = document.getElementById('chart-daily').getContext('2d');
  if (charts.daily) charts.daily.destroy();
  charts.daily = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: daily.map(d => d.day),
      datasets: [
        { label: 'Input', data: daily.map(d => d.input), backgroundColor: TOKEN_COLORS.input, stack: 'tokens' },
        { label: 'Output', data: daily.map(d => d.output), backgroundColor: TOKEN_COLORS.output, stack: 'tokens' },
        { label: 'Cache Read', data: daily.map(d => d.cache_read), backgroundColor: TOKEN_COLORS.cache_read, stack: 'tokens' },
        { label: 'Cache Creation', data: daily.map(d => d.cache_creation), backgroundColor: TOKEN_COLORS.cache_creation, stack: 'tokens' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8892a4', boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: '#8892a4', maxTicksLimit: RANGE_TICKS[selectedRange] }, grid: { color: '#2a2d3a' } },
        y: { ticks: { color: '#8892a4', callback: v => fmt(v) }, grid: { color: '#2a2d3a' } },
      }
    }
  });
}
function renderModelChart(byModel) {
  const ctx = document.getElementById('chart-model').getContext('2d');
  if (charts.model) charts.model.destroy();
  if (!byModel.length) { charts.model = null; return; }
  charts.model = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: byModel.map(m => m.model),
      datasets: [{ data: byModel.map(m => m.input + m.output), backgroundColor: MODEL_COLORS, borderWidth: 2, borderColor: '#1a1d27' }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#8892a4', boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ' ' + ctx.label + ': ' + fmt(ctx.raw) + ' tokens' } }
      }
    }
  });
}
function renderProjectChart(byProject) {
  const top = byProject.slice(0, 10);
  const ctx = document.getElementById('chart-project').getContext('2d');
  if (charts.project) charts.project.destroy();
  if (!top.length) { charts.project = null; return; }
  charts.project = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top.map(p => p.project.length > 22 ? '...' + p.project.slice(-20) : p.project),
      datasets: [
        { label: 'Input', data: top.map(p => p.input), backgroundColor: TOKEN_COLORS.input },
        { label: 'Output', data: top.map(p => p.output), backgroundColor: TOKEN_COLORS.output },
      ]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8892a4', boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: '#8892a4', callback: v => fmt(v) }, grid: { color: '#2a2d3a' } },
        y: { ticks: { color: '#8892a4', font: { size: 11 } }, grid: { color: '#2a2d3a' } },
      }
    }
  });
}
function renderSessionsTable(sessions) {
  document.getElementById('sessions-body').innerHTML = sessions.map(s => {
    const cost = calcCost(s.model, s.input, s.output, s.cache_read, s.cache_creation);
    const costCell = isBillable(s.model) ? '<td class="cost">' + fmtCost(cost) + '</td>' : '<td class="cost-na">n/a</td>';
    return '<tr><td class="muted" style="font-family:monospace">' + s.session_id + '&hellip;</td><td>' + s.project + '</td><td class="muted">' + s.last + '</td><td class="muted">' + s.duration_min + 'm</td><td><span class="model-tag">' + s.model + '</span></td><td class="num">' + s.turns + '</td><td class="num">' + fmt(s.input) + '</td><td class="num">' + fmt(s.output) + '</td>' + costCell + '</tr>';
  }).join('');
}
function renderModelCostTable(byModel) {
  document.getElementById('model-cost-body').innerHTML = byModel.map(m => {
    const cost = calcCost(m.model, m.input, m.output, m.cache_read, m.cache_creation);
    const costCell = isBillable(m.model) ? '<td class="cost">' + fmtCost(cost) + '</td>' : '<td class="cost-na">n/a</td>';
    return '<tr><td><span class="model-tag">' + m.model + '</span></td><td class="num">' + fmt(m.turns) + '</td><td class="num">' + fmt(m.input) + '</td><td class="num">' + fmt(m.output) + '</td><td class="num">' + fmt(m.cache_read) + '</td><td class="num">' + fmt(m.cache_creation) + '</td>' + costCell + '</tr>';
  }).join('');
}
async function loadData() {
  try {
    const resp = await fetch('/api/data');
    const d = await resp.json();
    if (d.error) {
      document.body.innerHTML = '<div style="padding:40px;color:#f87171">' + d.error + '</div>';
      return;
    }
    document.getElementById('meta').textContent = 'Updated: ' + d.generated_at + ' · Auto-refresh in 30s';
    const isFirstLoad = rawData === null;
    rawData = d;
    if (isFirstLoad) {
      selectedRange = readURLRange();
      document.querySelectorAll('.range-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.range === selectedRange));
      buildFilterUI(d.all_models);
    }
    applyFilter();
  } catch (error) {
    console.error(error);
  }
}
loadData();
setInterval(loadData, 30000);
</script>
</body>
</html>`;

export function serve(port = DASHBOARD_PORT): void {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(HTML_TEMPLATE);
      return;
    }
    if (url.pathname === "/api/data") {
      const data = getDashboardData();
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(data));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  server.on("error", (error) => {
    console.error(`Failed to start dashboard on http://localhost:${port}: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Dashboard running at http://localhost:${port}`);
    console.log("Press Ctrl+C to stop.");
  });
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "cmd" :
    "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] :
    [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", () => {});
  child.unref();
}

export function runDashboard(port = DASHBOARD_PORT): void {
  console.log("Running scan first...");
  scan();
  console.log("\nStarting dashboard server...");
  setTimeout(() => openBrowser(`http://localhost:${port}`), 1000);
  serve(port);
}
