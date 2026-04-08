import { homedir } from "node:os";
import path from "node:path";

export const CLAUDE_DIR = path.join(homedir(), ".claude");
export const PROJECTS_DIR = process.env.CLAUDE_USAGE_PROJECTS_DIR ?? path.join(CLAUDE_DIR, "projects");
export const DB_PATH = process.env.CLAUDE_USAGE_DB_PATH ?? path.join(CLAUDE_DIR, "usage.db");
export const DASHBOARD_PORT = Number(process.env.CLAUDE_USAGE_PORT ?? "8080");
