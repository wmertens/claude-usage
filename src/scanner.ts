import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH, PROJECTS_DIR } from "./constants.ts";
import { initDb, openDb } from "./db.ts";

type JsonObject = Record<string, unknown>;

export type Turn = {
  session_id: string;
  timestamp: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tool_name: string | null;
  cwd: string;
};

export type SessionMeta = {
  session_id: string;
  project_name: string;
  first_timestamp: string;
  last_timestamp: string;
  git_branch: string;
  model: string | null;
};

type SessionRecord = SessionMeta & {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_creation: number;
  turn_count: number;
};

type ScanResult = {
  new: number;
  updated: number;
  skipped: number;
  turns: number;
  sessions: number;
};

type ProcessedFileRow = {
  mtime?: number;
  lines?: number;
  size?: number;
};

function listJsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }
  results.sort();
  return results;
}

export function projectNameFromCwd(cwd: string): string {
  if (!cwd) {
    return "unknown";
  }
  const parts = cwd.replaceAll("\\", "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length >= 2) {
    return `${parts.at(-2)}/${parts.at(-1)}`;
  }
  return parts[0] ?? "unknown";
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function parseLine(line: string): JsonObject | null {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

function extractToolName(message: JsonObject | null): string | null {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const item of content) {
    const entry = asObject(item);
    if (entry?.type === "tool_use" && typeof entry.name === "string") {
      return entry.name;
    }
  }
  return null;
}

function parseAssistantRecord(record: JsonObject): Turn | null {
  if (record.type !== "assistant" || typeof record.sessionId !== "string") {
    return null;
  }

  const message = asObject(record.message);
  const usage = asObject(message?.usage);
  const inputTokens = Number(usage?.input_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? 0);
  const cacheReadTokens = Number(usage?.cache_read_input_tokens ?? 0);
  const cacheCreationTokens = Number(usage?.cache_creation_input_tokens ?? 0);

  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) {
    return null;
  }

  return {
    session_id: record.sessionId,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
    model: typeof message?.model === "string" && message.model ? message.model : null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    tool_name: extractToolName(message),
    cwd: typeof record.cwd === "string" ? record.cwd : ""
  };
}

function updateSessionMeta(metaMap: Map<string, SessionMeta>, record: JsonObject): void {
  if ((record.type !== "assistant" && record.type !== "user") || typeof record.sessionId !== "string") {
    return;
  }

  const sessionId = record.sessionId;
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
  const cwd = typeof record.cwd === "string" ? record.cwd : "";
  const gitBranch = typeof record.gitBranch === "string" ? record.gitBranch : "";
  const existing = metaMap.get(sessionId);

  if (!existing) {
    metaMap.set(sessionId, {
      session_id: sessionId,
      project_name: projectNameFromCwd(cwd),
      first_timestamp: timestamp,
      last_timestamp: timestamp,
      git_branch: gitBranch,
      model: null
    });
    return;
  }

  if (timestamp && (!existing.first_timestamp || timestamp < existing.first_timestamp)) {
    existing.first_timestamp = timestamp;
  }
  if (timestamp && (!existing.last_timestamp || timestamp > existing.last_timestamp)) {
    existing.last_timestamp = timestamp;
  }
  if (gitBranch && !existing.git_branch) {
    existing.git_branch = gitBranch;
  }
}

function parseJsonlFile(
  filePath: string,
  oldLines = 0
): { sessionMetas: SessionMeta[]; turns: Turn[]; lineCount: number } {
  const turns: Turn[] = [];
  const sessionMetaMap = new Map<string, SessionMeta>();
  let lineCount = 0;

  try {
    const content = fs.readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      if (rawLine === "") {
        continue;
      }
      lineCount += 1;
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const record = parseLine(line);
      if (!record) {
        continue;
      }
      updateSessionMeta(sessionMetaMap, record);
      if (lineCount > oldLines) {
        const turn = parseAssistantRecord(record);
        if (turn) {
          turns.push(turn);
          const meta = sessionMetaMap.get(turn.session_id);
          if (meta && turn.model) {
            meta.model = turn.model;
          }
        }
      } else if (record.type === "assistant") {
        const message = asObject(record.message);
        if (typeof record.sessionId === "string" && typeof message?.model === "string" && message.model) {
          const meta = sessionMetaMap.get(record.sessionId);
          if (meta) {
            meta.model = message.model;
          }
        }
      }
    }
  } catch (error) {
    console.warn(`  Warning: error reading ${filePath}: ${String(error)}`);
  }

  return { sessionMetas: [...sessionMetaMap.values()], turns, lineCount };
}

function aggregateSessions(sessionMetas: SessionMeta[], turns: Turn[]): SessionRecord[] {
  const stats = new Map<string, Omit<SessionRecord, keyof SessionMeta>>();

  for (const turn of turns) {
    const current = stats.get(turn.session_id) ?? {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read: 0,
      total_cache_creation: 0,
      turn_count: 0
    };
    current.total_input_tokens += turn.input_tokens;
    current.total_output_tokens += turn.output_tokens;
    current.total_cache_read += turn.cache_read_tokens;
    current.total_cache_creation += turn.cache_creation_tokens;
    current.turn_count += 1;
    stats.set(turn.session_id, current);
  }

  return sessionMetas.map((meta) => ({
    ...meta,
    ...(stats.get(meta.session_id) ?? {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read: 0,
      total_cache_creation: 0,
      turn_count: 0
    })
  }));
}

function upsertSessions(db: DatabaseSync, sessions: SessionRecord[]): void {
  const selectStmt = db.prepare(`
    SELECT total_input_tokens
    FROM sessions
    WHERE session_id = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO sessions (
      session_id, project_name, first_timestamp, last_timestamp, git_branch,
      total_input_tokens, total_output_tokens, total_cache_read, total_cache_creation,
      model, turn_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE sessions SET
      project_name = COALESCE(NULLIF(?, ''), project_name),
      first_timestamp = CASE
        WHEN first_timestamp IS NULL OR first_timestamp = '' THEN ?
        WHEN ? <> '' AND ? < first_timestamp THEN ?
        ELSE first_timestamp
      END,
      last_timestamp = CASE
        WHEN last_timestamp IS NULL OR last_timestamp = '' THEN ?
        WHEN ? <> '' AND ? > last_timestamp THEN ?
        ELSE last_timestamp
      END,
      git_branch = COALESCE(NULLIF(?, ''), git_branch),
      total_input_tokens = total_input_tokens + ?,
      total_output_tokens = total_output_tokens + ?,
      total_cache_read = total_cache_read + ?,
      total_cache_creation = total_cache_creation + ?,
      turn_count = turn_count + ?,
      model = COALESCE(?, model)
    WHERE session_id = ?
  `);

  for (const session of sessions) {
    const existing = selectStmt.get(session.session_id) as Record<string, unknown> | undefined;
    if (!existing) {
      insertStmt.run(
        session.session_id,
        session.project_name,
        session.first_timestamp,
        session.last_timestamp,
        session.git_branch,
        session.total_input_tokens,
        session.total_output_tokens,
        session.total_cache_read,
        session.total_cache_creation,
        session.model,
        session.turn_count
      );
      continue;
    }

    updateStmt.run(
      session.project_name,
      session.first_timestamp,
      session.first_timestamp,
      session.first_timestamp,
      session.first_timestamp,
      session.last_timestamp,
      session.last_timestamp,
      session.last_timestamp,
      session.last_timestamp,
      session.git_branch,
      session.total_input_tokens,
      session.total_output_tokens,
      session.total_cache_read,
      session.total_cache_creation,
      session.turn_count,
      session.model,
      session.session_id
    );
  }
}

function insertTurns(db: DatabaseSync, turns: Turn[]): void {
  if (turns.length === 0) {
    return;
  }
  const stmt = db.prepare(`
    INSERT INTO turns (
      session_id, timestamp, model, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, tool_name, cwd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const turn of turns) {
    stmt.run(
      turn.session_id,
      turn.timestamp,
      turn.model,
      turn.input_tokens,
      turn.output_tokens,
      turn.cache_read_tokens,
      turn.cache_creation_tokens,
      turn.tool_name,
      turn.cwd
    );
  }
}

export function scan(projectsDir = PROJECTS_DIR, dbPath = DB_PATH, verbose = true): ScanResult {
  const db = openDb(dbPath);
  initDb(db);

  const jsonlFiles = listJsonlFiles(projectsDir);
  let newFiles = 0;
  let updatedFiles = 0;
  let skippedFiles = 0;
  let totalTurns = 0;
  const totalSessions = new Set<string>();

  const getProcessedStmt = db.prepare(`
    SELECT mtime, lines, size
    FROM processed_files
    WHERE path = ?
  `);
  const upsertProcessedStmt = db.prepare(`
    INSERT INTO processed_files (path, mtime, lines, size)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      mtime = excluded.mtime,
      lines = excluded.lines,
      size = excluded.size
  `);

  db.exec("BEGIN");
  try {
    for (const filePath of jsonlFiles) {
      let mtime = 0;
      let size = 0;
      try {
        const stat = fs.statSync(filePath);
        mtime = stat.mtimeMs;
        size = stat.size;
      } catch {
        continue;
      }

      const previous = getProcessedStmt.get(filePath) as ProcessedFileRow | undefined;
      if (
        previous &&
        Math.abs((previous.mtime ?? 0) - mtime) < 0.01 &&
        (previous.size ?? 0) === size
      ) {
        skippedFiles += 1;
        continue;
      }

      const isNew = !previous;
      if (verbose) {
        const status = isNew ? "NEW" : "UPD";
        console.log(`  [${status}] ${path.relative(projectsDir, filePath)}`);
      }

      const oldLines = previous?.lines ?? 0;
      const parsed = parseJsonlFile(filePath, isNew ? 0 : oldLines);
      const lineCount = parsed.lineCount;

      if (!isNew && lineCount <= oldLines) {
        upsertProcessedStmt.run(filePath, mtime, lineCount, size);
        skippedFiles += 1;
        continue;
      }

      const turns = parsed.turns;
      let sessions = aggregateSessions(parsed.sessionMetas, turns);

      if (!isNew) {
        const incrementalIds = new Set(sessions.map((session) => session.session_id));
        for (const meta of parsed.sessionMetas) {
          if (!incrementalIds.has(meta.session_id)) {
            sessions.push({
              ...meta,
              total_input_tokens: 0,
              total_output_tokens: 0,
              total_cache_read: 0,
              total_cache_creation: 0,
              turn_count: 0
            });
          }
        }
        updatedFiles += 1;
      } else {
        newFiles += 1;
      }

      upsertSessions(db, sessions);
      insertTurns(db, turns);
      upsertProcessedStmt.run(filePath, mtime, lineCount, size);

      for (const session of sessions) {
        totalSessions.add(session.session_id);
      }
      totalTurns += turns.length;
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  if (verbose) {
    console.log("\nScan complete:");
    console.log(`  New files:     ${newFiles}`);
    console.log(`  Updated files: ${updatedFiles}`);
    console.log(`  Skipped files: ${skippedFiles}`);
    console.log(`  Turns added:   ${totalTurns}`);
    console.log(`  Sessions seen: ${totalSessions.size}`);
  }

  db.close();
  return {
    new: newFiles,
    updated: updatedFiles,
    skipped: skippedFiles,
    turns: totalTurns,
    sessions: totalSessions.size
  };
}
