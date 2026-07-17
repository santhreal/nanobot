import { AlertCircle, Globe2, Search } from "lucide-react";
import { useMemo } from "react";

import { ActivityStep } from "@/components/thread/activity/ActivityStep";
import type { WebSearchRunModel, WebSearchSource } from "@/components/thread/activity/web-search-model";
import { useLogoFallback } from "@/hooks/useLogoFallback";
import { faviconUrls } from "@/lib/provider-brand";

export function WebSearchRun({ run, turnActive }: { run: WebSearchRunModel; turnActive: boolean }) {
  const active = run.status === "running" && turnActive;
  const status = run.status === "running" && !turnActive ? "done" : run.status;
  const label = status === "error"
    ? "Web search failed"
    : status === "running"
      ? "Searching the web"
      : "Searched the web";

  return (
    <ul className="space-y-1" data-testid="activity-web-search-run">
      <ActivityStep
        as="li"
        icon={status === "error" ? AlertCircle : Search}
        active={active}
        tone={status === "error" ? "error" : status === "done" ? "success" : "active"}
        label={label}
        detail={run.query}
        aside={run.sources.length ? (
          <span className="text-[11px] text-muted-foreground/58">
            {run.sources.length} {run.sources.length === 1 ? "source" : "sources"}
          </span>
        ) : null}
      >
        {run.sources.length ? <WebSearchSources sources={run.sources} /> : null}
        {status === "error" && run.error ? (
          <p className="mt-1 break-words text-[11px] leading-4 text-destructive/72">{run.error}</p>
        ) : null}
      </ActivityStep>
    </ul>
  );
}

function WebSearchSources({ sources }: { sources: WebSearchSource[] }) {
  return (
    <ul className="space-y-0.5 pr-1" data-testid="activity-web-search-results">
      {sources.map((source) => (
        <li key={source.href} className="min-w-0">
          <a
            href={source.href}
            target="_blank"
            rel="noreferrer"
            className="group/source flex min-w-0 items-center gap-2 rounded-[6px] px-1.5 py-1 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
            title={`${source.title} — ${source.href}`}
          >
            <SourceFavicon source={source} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground/82">
              {source.title}
            </span>
            <span
              className="max-w-[46%] shrink-0 truncate rounded-full bg-muted/65 px-2 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground/72 transition-colors group-hover/source:bg-muted/85"
              data-testid="activity-web-search-url"
            >
              {source.displayUrl}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function SourceFavicon({ source }: { source: WebSearchSource }) {
  const candidates = useMemo(() => faviconUrls(source.host), [source.host]);
  const { logoUrl, onLogoError, onLogoLoad } = useLogoFallback(candidates);

  if (!logoUrl) {
    return <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground/52" aria-hidden />;
  }

  return (
    <img
      src={logoUrl}
      alt=""
      className="h-4 w-4 shrink-0 rounded-[3px] object-contain"
      decoding="async"
      loading="lazy"
      onLoad={onLogoLoad}
      onError={onLogoError}
      data-testid={`activity-web-search-favicon-${source.host}`}
    />
  );
}
