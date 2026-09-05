import type { CompanyConfig, Connector, SourceArtifact } from "../types.js";
import { hash, isoNow, stableId } from "../util.js";

interface GitHubItem {
  id: number;
  html_url: string;
  title: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  state: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
  repository_url: string;
}

export class GitHubConnector implements Connector {
  readonly source = "github" as const;
  constructor(private readonly token: string | undefined, private readonly timeoutMs: number) {}

  async *collect(company: CompanyConfig, signal: AbortSignal): AsyncIterable<SourceArtifact> {
    for (const org of company.githubOrganizations) {
      const endpoint = `https://api.github.com/search/issues?q=org:${encodeURIComponent(org)}+is:public&sort=updated&order=desc&per_page=100`;
      const response = await fetch(endpoint, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        headers: {
          accept: "application/vnd.github+json", "user-agent": "ManiculePromptgen/2.0",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
      }).catch(() => undefined);
      if (!response?.ok) continue;
      const payload = await response.json() as { items?: GitHubItem[] };
      for (const item of payload.items ?? []) {
        const content = `${item.title}\n\n${item.body ?? ""}`.trim();
        const version = hash(`${item.updated_at}:${content}`).slice(0, 16);
        yield {
          id: stableId(company.id, "github", String(item.id), version), companyId: company.id, source: "github",
          externalId: String(item.id), version, occurredAt: item.updated_at, collectedAt: isoNow(), visibility: "public",
          title: item.title, content: content.slice(0, 40_000), url: item.html_url,
          metadata: { state: item.state, createdAt: item.created_at, labels: item.labels.map(label => label.name), kind: item.pull_request ? "pull-request" : "issue", repositoryUrl: item.repository_url },
        };
      }
    }
  }
}
