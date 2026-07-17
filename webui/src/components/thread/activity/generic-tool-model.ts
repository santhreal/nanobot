import type { ActivityEvidence } from "@/lib/activity-timeline";

export type GenericToolStatus = "running" | "done" | "error";
export type ToolFamily = "content-search" | "file-search" | "list" | "read" | "memory" | "generic";

export interface ToolField {
  key: "query" | "pattern" | "glob" | "path" | "file_path" | "url";
  value: string;
}

export interface GenericToolTrace {
  name: string;
  family: ToolFamily;
  groupKey: string;
  fields: ToolField[];
  collectedSource: boolean;
}

export interface GenericToolRunItem {
  trace: GenericToolTrace;
  status: GenericToolStatus;
  error?: string;
  evidence?: ActivityEvidence[];
}

const CONTENT_SEARCH_TOOLS = new Set([
  "grep",
  "rg",
  "ripgrep",
  "search_code",
  "search_content",
  "search_files_content",
  "find_text",
]);
const FILE_SEARCH_TOOLS = new Set([
  "find",
  "find_file",
  "find_files",
  "glob",
  "search_files",
]);
const LIST_TOOLS = new Set(["list_dir", "list_directory", "list_files", "ls"]);
const READ_TOOLS = new Set(["read", "read_file", "read_text_file"]);
const MEMORY_TOOLS = new Set(["memory_search", "search_memory", "recall_memory"]);
const EXCLUDED_TOOL_PREFIXES = ["mcp_"];
const EXCLUDED_TOOLS = new Set([
  "apply_patch",
  "cli_anything_run",
  "edit_file",
  "exec",
  "exec_command",
  "execute_command",
  "run_cli_app",
  "run_command",
  "run_shell",
  "shell",
  "terminal",
  "web_fetch",
  "web_search",
  "write_file",
]);

export function parseGenericToolTrace(line: string): GenericToolTrace | null {
  const call = parseCall(line);
  if (!call || isExcludedTool(call.name)) return null;
  const family = toolFamily(call.name);
  const fields = safeFields(call.args);
  const collectedSource = fields.some((field) => isCollectedSourcePath(field.value));
  return {
    name: call.name,
    family,
    groupKey: family === "generic"
      ? `${family}:${call.name}`
      : `${family}:${collectedSource ? "collected" : "workspace"}`,
    fields,
    collectedSource,
  };
}

export function canGroupGenericToolRuns(previous: GenericToolRunItem, next: GenericToolRunItem): boolean {
  return previous.trace.groupKey === next.trace.groupKey;
}

export function compactGenericToolPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (isCollectedSourcePath(normalized)) {
    return truncateMiddle(normalized.split("/").pop() || "collected source", 64);
  }
  return normalized
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~");
}

function parseCall(line: string): { name: string; args: unknown } | null {
  const match = /^([a-zA-Z0-9_.-]+)\((.*)\)$/.exec(line.trim());
  if (!match) return null;
  const name = compactToolName(match[1]);
  let args: unknown;
  try {
    args = match[2].trim() ? JSON.parse(match[2]) : {};
  } catch {
    args = {};
  }
  return { name, args };
}

function compactToolName(name: string): string {
  return name.toLowerCase().split(".").pop() || name.toLowerCase();
}

function isExcludedTool(name: string): boolean {
  return EXCLUDED_TOOLS.has(name) || EXCLUDED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function toolFamily(name: string): ToolFamily {
  if (CONTENT_SEARCH_TOOLS.has(name)) return "content-search";
  if (FILE_SEARCH_TOOLS.has(name)) return "file-search";
  if (LIST_TOOLS.has(name)) return "list";
  if (READ_TOOLS.has(name)) return "read";
  if (MEMORY_TOOLS.has(name)) return "memory";
  return "generic";
}

function safeFields(args: unknown): ToolField[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const fields: ToolField[] = [];
  for (const key of ["query", "pattern", "glob", "path", "file_path", "url"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) fields.push({ key, value: value.trim() });
  }
  return fields;
}

function isCollectedSourcePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.includes("/.nanobot/tool-results/") || normalized.includes("/nanobot/tool-results/");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const head = Math.ceil((maxLength - 1) * 0.62);
  const tail = Math.floor((maxLength - 1) * 0.38);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
