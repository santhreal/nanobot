import { formatToolCallTrace } from "@/lib/tool-traces";
import type { ToolProgressEvent } from "@/lib/types";

import { displayWebHost, formatCompactWebUrl, parsePublicHttpUrl } from "./web-url";

export type WebSearchStatus = "running" | "done" | "error";

export interface WebSearchSource {
  title: string;
  href: string;
  host: string;
  displayUrl: string;
}

export interface WebSearchRunModel {
  key: string;
  query: string;
  status: WebSearchStatus;
  sources: WebSearchSource[];
  error?: string;
}

const WEB_SEARCH_STATUS_RANK: Record<WebSearchStatus, number> = {
  running: 1,
  done: 2,
  error: 3,
};
const MAX_VISIBLE_SOURCES = 8;

export function webSearchRunsByTraceLine(
  events: ToolProgressEvent[],
): Map<string, WebSearchRunModel> {
  const runs = new Map<string, WebSearchRunModel>();
  for (const event of events) {
    const run = webSearchRunFromEvent(event);
    const line = run ? formatToolCallTrace(event) : null;
    if (!run || !line) continue;
    runs.set(line, mergeWebSearchRun(runs.get(line), run));
  }
  return runs;
}

export function webSearchRunFromEvent(event: ToolProgressEvent): WebSearchRunModel | null {
  const name = compactToolName(toolEventName(event));
  if (name !== "web_search") return null;

  const args = toolEventArguments(event);
  const query = stringField(args, ["query", "q", "text"]);
  const status: WebSearchStatus = event.phase === "error"
    ? "error"
    : event.phase === "end"
      ? "done"
      : "running";

  return {
    key: event.call_id ? `call:${event.call_id}` : formatToolCallTrace(event) ?? `web_search:${query}`,
    query,
    status,
    sources: status === "done" ? webSearchSources(event.result) : [],
    error: status === "error" ? readableError(event.error) : undefined,
  };
}

export function mergeWebSearchRun(
  existing: WebSearchRunModel | undefined,
  incoming: WebSearchRunModel,
): WebSearchRunModel {
  if (!existing) return incoming;
  if (WEB_SEARCH_STATUS_RANK[incoming.status] < WEB_SEARCH_STATUS_RANK[existing.status]) {
    return existing;
  }
  return {
    ...existing,
    ...incoming,
    query: incoming.query || existing.query,
    sources: incoming.sources.length ? incoming.sources : existing.sources,
  };
}

function webSearchSources(result: unknown): WebSearchSource[] {
  const candidates = structuredCandidates(result);
  if (typeof result === "string") candidates.push(...textCandidates(result));
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    for (const key of ["content", "text", "result"]) {
      if (typeof record[key] === "string") candidates.push(...textCandidates(record[key]));
    }
  }

  const seen = new Set<string>();
  const sources: WebSearchSource[] = [];
  for (const candidate of candidates) {
    const url = parsePublicHttpUrl(candidate.url);
    if (!url || seen.has(url.href)) continue;
    seen.add(url.href);
    sources.push({
      title: cleanTitle(candidate.title) || displayWebHost(url.hostname),
      href: url.href,
      host: displayWebHost(url.hostname),
      displayUrl: formatCompactWebUrl(url),
    });
    if (sources.length >= MAX_VISIBLE_SOURCES) break;
  }
  return sources;
}

function structuredCandidates(value: unknown): Array<{ title: string; url: string }> {
  const items: unknown[] = [];
  if (Array.isArray(value)) items.push(...value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["results", "items", "sources", "data"]) {
      if (Array.isArray(record[key])) items.push(...record[key]);
    }
  }

  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const title = stringField(record, ["title", "name", "label"]);
    const url = stringField(record, ["url", "href", "link", "uri"]);
    return url ? [{ title, url }] : [];
  });
}

function textCandidates(text: string): Array<{ title: string; url: string }> {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const candidates: Array<{ title: string; url: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;

    const markdownLink = /^\s*(?:\d+[.)]\s*)?\[([^\]]+)]\((https?:\/\/[^)]+)\)\s*$/.exec(line);
    if (markdownLink) {
      candidates.push({ title: markdownLink[1], url: markdownLink[2] });
      continue;
    }

    const numberedTitle = /^\d+[.)]\s+(.+)$/.exec(line);
    if (!numberedTitle) continue;

    const inlineUrl = firstHttpUrl(numberedTitle[1]);
    if (inlineUrl) {
      candidates.push({
        title: numberedTitle[1].replace(inlineUrl, "").replace(/[\s:|\-–—]+$/, ""),
        url: inlineUrl,
      });
      continue;
    }

    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^\d+[.)]\s+/.test(lines[next])) break;
      const url = firstHttpUrl(lines[next]);
      if (!url) continue;
      candidates.push({ title: numberedTitle[1], url });
      break;
    }
  }

  return candidates;
}

function firstHttpUrl(value: string): string {
  return value.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;\]}]+$/, "") ?? "";
}

function cleanTitle(value: string): string {
  return value
    .replace(/^#+\s*/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/^__(.*)__$/, "$1")
    .trim();
}

function compactToolName(name: string): string {
  return name.toLowerCase().split(".").pop() || name.toLowerCase();
}

function toolEventName(event: ToolProgressEvent): string {
  const functionName = (event as { function?: { name?: unknown } }).function?.name;
  if (typeof functionName === "string") return functionName;
  return typeof event.name === "string" ? event.name : "";
}

function toolEventArguments(event: ToolProgressEvent): unknown {
  const functionArgs = (event as { function?: { arguments?: unknown } }).function?.arguments;
  const raw = functionArgs ?? event.arguments;
  if (typeof raw !== "string") return raw ?? {};
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function stringField(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return "";
}

function readableError(error: unknown): string | undefined {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (!error) return undefined;
  try {
    return JSON.stringify(error);
  } catch {
    return "Web search failed";
  }
}
