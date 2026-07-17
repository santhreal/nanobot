import {
  AlertCircle,
  Check,
  ChevronRight,
  CircleDashed,
  FileSearch,
  FolderOpen,
  ListTree,
  MemoryStick,
  Play,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";

import { ActivityEvidencePreview } from "@/components/thread/activity/ActivityEvidencePreview";
import { ActivityStep } from "@/components/thread/activity/ActivityStep";
import {
  compactGenericToolPath,
  type GenericToolRunItem,
  type GenericToolStatus,
  type ToolFamily,
  type ToolField,
} from "@/components/thread/activity/generic-tool-model";
import type { ActivityEvidence } from "@/lib/activity-timeline";
import { cn } from "@/lib/utils";

interface GenericToolRunModel {
  status: GenericToolStatus;
  label: string;
  aside: string;
  icon: LucideIcon;
}

export function GenericToolRun({ items }: { items: GenericToolRunItem[] }) {
  const model = useMemo(() => buildModel(items), [items]);
  const ActivityIcon = model.icon;
  const StatusIcon = model.status === "error"
    ? AlertCircle
    : model.status === "running"
      ? CircleDashed
      : Check;
  const evidence = uniqueEvidence(items.flatMap((item) => item.evidence ?? []));

  return (
    <li
      className="list-none"
      data-status={model.status}
      data-testid="activity-generic-tool-run"
    >
      <details className="group/generic-tool-run">
        <summary
          className="cursor-pointer list-none rounded-[5px] outline-none transition-colors hover:bg-muted/26 focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden"
          aria-label={`Technical details for ${model.label}`}
        >
          <ActivityStep
            marker={(
              <span className="relative grid h-4 w-4 place-items-center">
                <ActivityIcon
                  className={cn(
                    "h-3.5 w-3.5",
                    model.status === "error"
                      ? "text-destructive/78"
                      : model.status === "running"
                        ? "text-muted-foreground/72"
                        : "text-muted-foreground/48",
                  )}
                  aria-hidden
                />
                <StatusIcon
                  className={cn(
                    "absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full bg-background",
                    model.status === "error"
                      ? "text-destructive/82"
                      : model.status === "running"
                        ? "animate-spin text-muted-foreground/58"
                        : "text-emerald-500/78",
                  )}
                  strokeWidth={2.4}
                  aria-hidden
                />
              </span>
            )}
            active={model.status === "running"}
            tone={model.status === "error" ? "error" : model.status === "done" ? "success" : "active"}
            label={model.label}
            aside={(
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/62">
                {model.aside ? <span>{model.aside}</span> : null}
                <ChevronRight
                  className="h-3.5 w-3.5 transition-transform duration-150 group-open/generic-tool-run:rotate-90"
                  aria-hidden
                />
              </span>
            )}
            className="px-1"
          />
        </summary>

        <div className="mb-1.5 ml-[1.625rem] mt-1 border-l border-border/45 pl-3 text-[11px] leading-[17px] text-muted-foreground/72">
          <p className="mb-1 font-medium text-foreground/64">Technical details</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
            <dt>Tool</dt>
            <dd className="min-w-0 font-mono text-foreground/68">{uniqueToolNames(items).join(", ")}</dd>
            {technicalFields(items).map((field) => (
              <ToolDetailField key={`${field.label}:${field.values.join("|")}`} field={field} />
            ))}
            {model.status === "error" ? (
              <>
                <dt className="text-destructive/75">Error</dt>
                <dd className="min-w-0 break-words text-destructive/78">
                  {safeError(items) || "Tool call failed"}
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      </details>
      {evidence.length ? (
        <ActivityEvidencePreview evidence={evidence} className="ml-[1.625rem] mt-1" />
      ) : null}
    </li>
  );
}

function ToolDetailField({ field }: { field: { label: string; values: string[]; paths: boolean } }) {
  const displayValue = (value: string) => {
    const redacted = redactSensitiveText(value);
    return field.paths ? compactGenericToolPath(redacted) : redacted;
  };

  return (
    <>
      <dt>{field.label}</dt>
      <dd className="min-w-0">
        {field.values.length === 1 ? (
          <code className="break-words font-mono text-foreground/68" title={field.paths ? displayValue(field.values[0]) : undefined}>
            {displayValue(field.values[0])}
          </code>
        ) : (
          <ul className="space-y-0.5">
            {field.values.map((value, index) => (
              <li key={`${value}:${index}`}>
                <code className="break-words font-mono text-foreground/68" title={field.paths ? displayValue(value) : undefined}>
                  {displayValue(value)}
                </code>
              </li>
            ))}
          </ul>
        )}
      </dd>
    </>
  );
}

function buildModel(items: GenericToolRunItem[]): GenericToolRunModel {
  const family = items[0]?.trace.family ?? "generic";
  const status = aggregateStatus(items);
  const collected = items.every((item) => item.trace.collectedSource);
  return {
    status,
    label: activityLabel(family, status, collected, items[0]?.trace.name ?? "tool"),
    aside: activityAside(items, family),
    icon: activityIcon(family),
  };
}

function aggregateStatus(items: GenericToolRunItem[]): GenericToolStatus {
  if (items.some((item) => item.status === "error")) return "error";
  if (items.some((item) => item.status === "running")) return "running";
  return "done";
}

function activityLabel(
  family: ToolFamily,
  status: GenericToolStatus,
  collected: boolean,
  toolName: string,
): string {
  const failed = status === "error";
  const running = status === "running";
  if (family === "content-search") {
    if (failed) return collected ? "Could not search collected sources" : "Could not search files";
    if (collected) return running ? "Searching collected sources" : "Searched collected sources";
    return running ? "Searching files" : "Searched files";
  }
  if (family === "file-search") {
    if (failed) return "Could not find files";
    return running ? "Finding files" : "Found files";
  }
  if (family === "list") {
    if (failed) return "Could not list files";
    return running ? "Listing files" : "Listed files";
  }
  if (family === "read") {
    if (failed) return collected ? "Could not read collected source" : "Could not read file";
    if (collected) return running ? "Reading collected source" : "Read collected source";
    return running ? "Reading file" : "Read file";
  }
  if (family === "memory") {
    if (failed) return "Could not search memory";
    return running ? "Searching memory" : "Searched memory";
  }
  const name = humanizeToolName(toolName);
  if (failed) return `${name} failed`;
  return running ? `Running ${name}` : `Ran ${name}`;
}

function activityAside(items: GenericToolRunItem[], family: ToolFamily): string {
  const pathCount = uniqueValues(items, ["path", "file_path"]).length;
  if (pathCount > 1) return `${pathCount} files`;
  if (items.length > 1) {
    if (family === "content-search" || family === "file-search" || family === "memory") {
      return `${items.length} searches`;
    }
    return `${items.length} actions`;
  }
  return "";
}

function activityIcon(family: ToolFamily): LucideIcon {
  if (family === "content-search" || family === "file-search") return FileSearch;
  if (family === "list") return ListTree;
  if (family === "read") return FolderOpen;
  if (family === "memory") return MemoryStick;
  return Play;
}

function technicalFields(items: GenericToolRunItem[]) {
  const query = uniqueValues(items, ["query"]);
  const pattern = uniqueValues(items, ["pattern"]);
  const glob = uniqueValues(items, ["glob"]);
  const paths = uniqueValues(items, ["path", "file_path", "url"]);
  return [
    { label: "Query", values: query, paths: false },
    { label: "Pattern", values: pattern, paths: false },
    { label: "Glob", values: glob, paths: false },
    { label: paths.length > 1 ? "Files" : "File", values: paths, paths: true },
  ].filter((field) => field.values.length > 0);
}

function uniqueValues(items: GenericToolRunItem[], keys: ToolField["key"][]): string[] {
  const values = items.flatMap((item) => item.trace.fields)
    .filter((field) => keys.includes(field.key))
    .map((field) => field.value);
  return [...new Set(values)];
}

function uniqueToolNames(items: GenericToolRunItem[]): string[] {
  return [...new Set(items.map((item) => item.trace.name))];
}

function safeError(items: GenericToolRunItem[]): string | undefined {
  const error = items.find((item) => item.error)?.error;
  if (!error) return undefined;
  return truncateMiddle(redactSensitiveText(error), 320);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1<redacted>@")
    .replace(
      /(["']?authorization["']?\s*[:=]\s*["']?)[^"'\r\n,;}]+/gi,
      "$1<redacted>",
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|token|secret|password)["']?\s*[:=]\s*)["']?[^"'\s,&;}]+["']?/gi,
      "$1<redacted>",
    );
}

function uniqueEvidence(evidence: ActivityEvidence[]): ActivityEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = item.attachment.url || item.attachment.name || item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const head = Math.ceil((maxLength - 1) * 0.62);
  const tail = Math.floor((maxLength - 1) * 0.38);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function humanizeToolName(name: string): string {
  return name
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
