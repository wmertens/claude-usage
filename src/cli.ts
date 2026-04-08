import { DB_PATH, DASHBOARD_PORT, PROJECTS_DIR } from "./constants.ts";
import { calcCost, fmt, fmtCost } from "./costs.ts";
import { requireDb } from "./db.ts";
import { runDashboard } from "./dashboard.ts";
import { scan } from "./scanner.ts";

function hr(char = "-", width = 60): void {
  console.log(char.repeat(width));
}

function cmdScan(): void {
  console.log(`Scanning ${PROJECTS_DIR} ...`);
  scan();
}

function cmdToday(): void {
  const db = requireDb(DB_PATH);
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT
      COALESCE(model, 'unknown') AS model,
      SUM(input_tokens) AS inp,
      SUM(output_tokens) AS out,
      SUM(cache_read_tokens) AS cr,
      SUM(cache_creation_tokens) AS cc,
      COUNT(*) AS turns
    FROM turns
    WHERE substr(timestamp, 1, 10) = ?
    GROUP BY model
    ORDER BY inp + out DESC
  `).all(today) as Array<Record<string, unknown>>;

  const sessions = db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS cnt
    FROM turns
    WHERE substr(timestamp, 1, 10) = ?
  `).get(today) as Record<string, unknown>;

  console.log("");
  hr();
  console.log(`  Today's Usage  (${today})`);
  hr();

  if (rows.length === 0) {
    console.log("  No usage recorded today.");
    console.log("");
    db.close();
    return;
  }

  let totalInp = 0;
  let totalOut = 0;
  let totalCr = 0;
  let totalCc = 0;
  let totalTurns = 0;
  let totalCost = 0;

  for (const row of rows) {
    const inp = Number(row.inp ?? 0);
    const out = Number(row.out ?? 0);
    const cr = Number(row.cr ?? 0);
    const cc = Number(row.cc ?? 0);
    const turns = Number(row.turns ?? 0);
    const model = String(row.model ?? "unknown");
    const cost = calcCost(model, inp, out, cr, cc);
    totalInp += inp;
    totalOut += out;
    totalCr += cr;
    totalCc += cc;
    totalTurns += turns;
    totalCost += cost;
    console.log(`  ${model.padEnd(30)}  turns=${String(turns).padEnd(4)}  in=${fmt(inp).padEnd(8)}  out=${fmt(out).padEnd(8)}  cost=${fmtCost(cost)}`);
  }

  hr();
  console.log(`  ${"TOTAL".padEnd(30)}  turns=${String(totalTurns).padEnd(4)}  in=${fmt(totalInp).padEnd(8)}  out=${fmt(totalOut).padEnd(8)}  cost=${fmtCost(totalCost)}`);
  console.log("");
  console.log(`  Sessions today:   ${Number(sessions.cnt ?? 0)}`);
  console.log(`  Cache read:       ${fmt(totalCr)}`);
  console.log(`  Cache creation:   ${fmt(totalCc)}`);
  hr();
  console.log("");
  db.close();
}

function cmdStats(): void {
  const db = requireDb(DB_PATH);
  const totals = db.prepare(`
    SELECT
      SUM(total_input_tokens) AS inp,
      SUM(total_output_tokens) AS out,
      SUM(total_cache_read) AS cr,
      SUM(total_cache_creation) AS cc,
      SUM(turn_count) AS turns,
      COUNT(*) AS sessions,
      MIN(first_timestamp) AS first,
      MAX(last_timestamp) AS last
    FROM sessions
  `).get() as Record<string, unknown>;

  const byModel = db.prepare(`
    SELECT
      COALESCE(model, 'unknown') AS model,
      SUM(total_input_tokens) AS inp,
      SUM(total_output_tokens) AS out,
      SUM(total_cache_read) AS cr,
      SUM(total_cache_creation) AS cc,
      SUM(turn_count) AS turns,
      COUNT(*) AS sessions
    FROM sessions
    GROUP BY model
    ORDER BY inp + out DESC
  `).all() as Array<Record<string, unknown>>;

  const topProjects = db.prepare(`
    SELECT
      project_name,
      SUM(total_input_tokens) AS inp,
      SUM(total_output_tokens) AS out,
      SUM(turn_count) AS turns,
      COUNT(*) AS sessions
    FROM sessions
    GROUP BY project_name
    ORDER BY inp + out DESC
    LIMIT 5
  `).all() as Array<Record<string, unknown>>;

  const dailyAvg = db.prepare(`
    SELECT
      AVG(daily_inp) AS avg_inp,
      AVG(daily_out) AS avg_out
    FROM (
      SELECT
        substr(timestamp, 1, 10) AS day,
        SUM(input_tokens) AS daily_inp,
        SUM(output_tokens) AS daily_out
      FROM turns
      WHERE timestamp >= datetime('now', '-30 days')
      GROUP BY day
    )
  `).get() as Record<string, unknown>;

  const totalCost = byModel.reduce((sum, row) => sum + calcCost(
    String(row.model ?? "unknown"),
    Number(row.inp ?? 0),
    Number(row.out ?? 0),
    Number(row.cr ?? 0),
    Number(row.cc ?? 0)
  ), 0);

  console.log("");
  hr("=");
  console.log("  Claude Code Usage - All-Time Statistics");
  hr("=");
  console.log(`  Period:           ${String(totals.first ?? "").slice(0, 10)} to ${String(totals.last ?? "").slice(0, 10)}`);
  console.log(`  Total sessions:   ${Number(totals.sessions ?? 0).toLocaleString()}`);
  console.log(`  Total turns:      ${fmt(Number(totals.turns ?? 0))}`);
  console.log("");
  console.log(`  Input tokens:     ${fmt(Number(totals.inp ?? 0)).padEnd(12)}  (raw prompt tokens)`);
  console.log(`  Output tokens:    ${fmt(Number(totals.out ?? 0)).padEnd(12)}  (generated tokens)`);
  console.log(`  Cache read:       ${fmt(Number(totals.cr ?? 0)).padEnd(12)}  (90% cheaper than input)`);
  console.log(`  Cache creation:   ${fmt(Number(totals.cc ?? 0)).padEnd(12)}  (25% premium on input)`);
  console.log("");
  console.log(`  Est. total cost:  ${fmtCost(totalCost)}`);
  hr();
  console.log("  By Model:");
  for (const row of byModel) {
    console.log(
      `    ${String(row.model ?? "unknown").padEnd(30)}  sessions=${String(row.sessions ?? 0).padEnd(4)}  turns=${fmt(Number(row.turns ?? 0)).padEnd(6)}  in=${fmt(Number(row.inp ?? 0)).padEnd(8)}  out=${fmt(Number(row.out ?? 0)).padEnd(8)}  cost=${fmtCost(calcCost(String(row.model ?? "unknown"), Number(row.inp ?? 0), Number(row.out ?? 0), Number(row.cr ?? 0), Number(row.cc ?? 0)))}`
    );
  }
  hr();
  console.log("  Top Projects:");
  for (const row of topProjects) {
    const name = String(row.project_name ?? "unknown") || "unknown";
    const tokens = Number(row.inp ?? 0) + Number(row.out ?? 0);
    console.log(`    ${name.padEnd(40)}  sessions=${String(row.sessions ?? 0).padEnd(3)}  turns=${fmt(Number(row.turns ?? 0)).padEnd(6)}  tokens=${fmt(tokens)}`);
  }
  if (Number(dailyAvg.avg_inp ?? 0) > 0) {
    hr();
    console.log("  Daily Average (last 30 days):");
    console.log(`    Input:   ${fmt(Math.trunc(Number(dailyAvg.avg_inp ?? 0)))}`);
    console.log(`    Output:  ${fmt(Math.trunc(Number(dailyAvg.avg_out ?? 0)))}`);
  }
  hr("=");
  console.log("");
  db.close();
}

function cmdDashboard(): void {
  runDashboard(DASHBOARD_PORT);
}

const USAGE = `
Claude Code Usage Dashboard

Usage:
  npm run scan       Scan JSONL files and update database
  npm run today      Show today's usage summary
  npm run stats      Show all-time statistics
  npm run dashboard  Scan + start dashboard at http://localhost:8080
`;

const commands: Record<string, () => void> = {
  scan: cmdScan,
  today: cmdToday,
  stats: cmdStats,
  dashboard: cmdDashboard
};

const command = process.argv[2];
if (!command || !(command in commands)) {
  console.log(USAGE);
  process.exit(0);
}

commands[command]();
