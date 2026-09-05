import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceArtifact, SourceType } from "../src/types.js";
import { hash, stableId } from "../src/util.js";

interface Seed { topic: string; problem: string; capability: string; segment: string; constraint: string }

const catalog: Record<string, Seed[]> = {
  greptile: [
    ["large-repositories", "AI code reviews lose context in very large repositories", "repository-wide codebase context", "platform engineering teams", "large monorepos"],
    ["review-noise", "automated reviews create too many low-value comments", "high-signal contextual review comments", "software teams", "low false-positive rate"],
    ["custom-rules", "teams need reviews to enforce internal engineering standards", "custom review rules", "regulated engineering teams", "organization-specific policies"],
    ["gitlab", "teams need AI review outside GitHub", "GitLab code review integration", "enterprise engineering teams", "GitLab-hosted repositories"],
    ["security", "security bugs escape ordinary pull-request review", "security-aware code analysis", "application security teams", "security-sensitive changes"],
    ["on-prem", "source code cannot leave company-controlled infrastructure", "self-hosted deployment options", "security-conscious enterprises", "private code"],
    ["review-speed", "human reviewers are a release bottleneck", "automated pull-request review", "high-velocity teams", "fast feedback"],
    ["stacked-prs", "dependent pull requests are difficult to review in isolation", "cross-change context", "large engineering organizations", "stacked changes"],
    ["legacy-code", "engineers struggle to understand unfamiliar legacy code", "codebase-aware explanations", "modernization teams", "poorly documented systems"],
    ["developer-adoption", "developers ignore generic bot comments", "contextual actionable suggestions", "engineering leaders", "developer trust"],
    ["compliance", "review evidence is difficult to audit", "review activity records", "regulated companies", "auditability"],
    ["multi-language", "review quality varies across programming languages", "multi-language code analysis", "polyglot teams", "mixed-language repositories"],
  ].map(toSeed),
  rootly: [
    ["slack-incidents", "incident coordination is fragmented across Slack messages", "Slack-native incident workflows", "SRE teams", "distributed responders"],
    ["on-call", "teams need to coordinate on-call response and escalation", "on-call and incident orchestration", "platform teams", "complex escalation policies"],
    ["postmortems", "postmortems take too long and miss incident context", "automated postmortem timelines", "reliability teams", "audit-ready reviews"],
    ["runbooks", "responders cannot find the right runbook under pressure", "contextual incident runbooks", "operations teams", "time-critical response"],
    ["status-pages", "customer communications lag behind incident response", "incident-linked status updates", "customer-facing SaaS teams", "multiple audiences"],
    ["pagerduty-migration", "teams want incident management beyond paging", "integrated incident lifecycle management", "PagerDuty users", "migration without response disruption"],
    ["automation", "manual incident administration distracts responders", "automated incident workflows", "lean SRE teams", "repetitive coordination work"],
    ["multi-team", "cross-team incidents have unclear ownership", "roles and multi-team coordination", "large organizations", "many dependent services"],
    ["metrics", "leaders cannot measure incident process effectiveness", "incident analytics and reporting", "engineering leadership", "MTTR and process metrics"],
    ["security-incidents", "security incidents need controlled collaboration", "permissioned incident workflows", "security operations teams", "sensitive incidents"],
    ["jira-sync", "incident follow-up work gets lost after resolution", "ticket and follow-up synchronization", "engineering teams", "Jira-based workflows"],
    ["ai-summaries", "responders waste time summarizing long incident threads", "AI-assisted incident summaries", "incident commanders", "high-message-volume incidents"],
  ].map(toSeed),
  reducto: [
    ["complex-pdfs", "standard parsers fail on complex PDF layouts", "layout-aware document parsing", "AI application teams", "multi-column documents"],
    ["tables", "tables lose structure during document extraction", "structured table extraction", "financial data teams", "merged cells and nested headers"],
    ["scanned-docs", "scanned documents produce poor OCR results", "OCR for scanned documents", "document operations teams", "low-quality scans"],
    ["handwriting", "handwritten fields are difficult to extract reliably", "handwriting-aware extraction", "insurance operations", "mixed printed and handwritten forms"],
    ["rag-ingestion", "document chunks lose layout and citation context in RAG", "document ingestion with grounded coordinates", "RAG engineering teams", "citation-sensitive answers"],
    ["schema-output", "teams need documents normalized into application schemas", "schema-based structured extraction", "automation teams", "variable source layouts"],
    ["batch-scale", "large document backlogs are slow to process", "batch document processing", "enterprise data teams", "high-volume ingestion"],
    ["financial-docs", "financial reports contain dense tables and footnotes", "financial document parsing", "financial analysts", "long filings"],
    ["forms", "checkboxes and form fields are lost by basic OCR", "form-aware extraction", "operations teams", "complex forms"],
    ["api-reliability", "document pipelines need predictable retries and status", "asynchronous parsing API", "platform engineers", "production workloads"],
    ["image-docs", "documents mix text with charts and images", "multimodal document understanding", "research teams", "chart-heavy reports"],
    ["data-residency", "sensitive documents require controlled processing", "enterprise deployment controls", "regulated enterprises", "confidential documents"],
  ].map(toSeed),
  supermemory: [
    ["cross-session", "AI assistants forget users between sessions", "persistent cross-session memory", "AI product teams", "long-lived users"],
    ["user-profiles", "applications repeatedly reconstruct user preferences", "automatically maintained user memory", "consumer AI teams", "personalized experiences"],
    ["memory-retrieval", "agents retrieve irrelevant old memories", "relevance-ranked memory retrieval", "agent developers", "large memory histories"],
    ["memory-api", "teams do not want to build memory infrastructure", "managed memory API", "startup engineering teams", "fast integration"],
    ["multi-agent", "multiple agents need access to shared user context", "shared application memory", "multi-agent platform teams", "agent attribution"],
    ["deduplication", "repeated conversations create duplicate memories", "memory consolidation", "assistant developers", "high conversation volume"],
    ["forgetting", "stale memories make agents behave incorrectly", "memory update and forgetting controls", "AI product teams", "changing preferences"],
    ["latency", "memory retrieval adds noticeable response latency", "low-latency memory search", "real-time AI applications", "interactive response times"],
    ["multimodal", "user context exists across links, documents and media", "multimodal memory ingestion", "knowledge assistant teams", "mixed content types"],
    ["privacy", "personal memories need deletion and privacy controls", "memory management APIs", "privacy-conscious applications", "user deletion requests"],
    ["frameworks", "memory integration differs across agent frameworks", "framework-agnostic memory integration", "AI infrastructure teams", "multiple SDKs"],
    ["observability", "developers cannot tell why a memory was recalled", "memory retrieval metadata", "agent platform teams", "debugging production agents"],
  ].map(toSeed),
};

function toSeed(values: string[]): Seed {
  const [topic, problem, capability, segment, constraint] = values;
  if (!topic || !problem || !capability || !segment || !constraint) throw new Error("Invalid seed");
  return { topic, problem, capability, segment, constraint };
}

const baseCounts: Record<Exclude<SourceType, "web" | "github">, number> = {
  gsc: 1500, slack: 900, intercom: 350, linear: 450, crm: 180, calls: 80, mintlify: 600,
};
const scale = Math.max(1, Number.parseInt(process.env.PROMPTGEN_FIXTURE_SCALE ?? "5", 10));
const counts = Object.fromEntries(Object.entries(baseCounts).map(([source, count]) => [source, count * scale])) as typeof baseCounts;

let state = 0x1a2b3c4d;
function random(): number {
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  return (state >>> 0) / 0x1_0000_0000;
}

function pick<T>(items: readonly T[]): T { return items[Math.floor(random() * items.length)]!; }
function dateBack(maxDays: number): string { return new Date(Date.UTC(2026, 8, 4) - Math.floor(random() * maxDays) * 86_400_000).toISOString(); }

const noise = [
  "Weekly planning notes and scheduling updates.", "The dashboard color looks different after the browser update.",
  "Following up on the invoice contact change.", "Team discussed vacation coverage and meeting times.",
  "Automated notification: workflow completed successfully.", "Can someone add me to the shared calendar?",
  "Internal test record created during onboarding.", "Customer confirmed the issue was caused by their network proxy.",
];

function render(source: Exclude<SourceType, "web" | "github">, seed: Seed, i: number): { title: string; content: string; metadata: Record<string, unknown> } {
  const useful = random() > 0.64;
  const timestamp = dateBack(source === "linear" ? 540 : 365);
  if (!useful) return { title: `${source} record ${i}`, content: pick(noise), metadata: { timestamp, labels: ["operations"], simulatedNoise: true } };
  const variants: Record<typeof source, () => string> = {
    slack: () => `Customer thread: ${seed.problem}. The ${seed.segment} said this matters because of ${seed.constraint}. After testing, the team confirmed that ${seed.capability} addresses the workflow.`,
    intercom: () => `Support request: ${seed.problem}. Customer context: ${seed.segment}; requirement: ${seed.constraint}. Resolution notes mention ${seed.capability}.`,
    linear: () => `${random() > .35 ? "Shipped" : "Investigating"}: improve ${seed.capability}. User reports show that ${seed.problem}, particularly for ${seed.segment}.`,
    gsc: () => `Search query: best ${seed.capability} for ${seed.constraint}. Impressions: ${20 + Math.floor(random() * 900)}. Clicks: ${Math.floor(random() * 30)}. Average position: ${(4 + random() * 40).toFixed(1)}.`,
    crm: () => `Deal note: ${seed.segment} is evaluating vendors because ${seed.problem}. Decision criterion: ${seed.constraint}. They responded positively to ${seed.capability}.`,
    calls: () => `Call transcript excerpt. Buyer: "${seed.problem}. We are ${seed.segment} and need ${seed.constraint}." Solution discussion covered ${seed.capability}.`,
    mintlify: () => `Documentation analytics: visitors reading about ${seed.capability} frequently search for ${seed.constraint}. ${12 + Math.floor(random() * 200)} views and ${1 + Math.floor(random() * 40)} searches in this period.`,
  };
  return { title: `${seed.topic.replaceAll("-", " ")} ${source} signal`, content: variants[source](), metadata: { timestamp, labels: [seed.topic], segment: seed.segment, simulatedNoise: false } };
}

async function main(): Promise<void> {
  const root = process.cwd();
  const fixtureRoot = path.join(root, "fixtures/private");
  const goldRoot = path.join(root, "fixtures/gold");
  await mkdir(goldRoot, { recursive: true });
  for (const [companyId, seeds] of Object.entries(catalog)) {
    const companyDir = path.join(fixtureRoot, companyId);
    await mkdir(companyDir, { recursive: true });
    for (const [source, count] of Object.entries(counts) as Array<[Exclude<SourceType, "web" | "github">, number]>) {
      const rows: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const seed = pick(seeds);
        const rendered = render(source, seed, i);
        const occurredAt = String(rendered.metadata.timestamp);
        const externalId = `${source}-${i.toString().padStart(5, "0")}`;
        const version = hash(rendered.content).slice(0, 16);
        const artifact: SourceArtifact = {
          id: stableId(companyId, source, externalId, version), companyId, source, externalId, version,
          occurredAt, collectedAt: "2026-09-04T00:00:00.000Z", visibility: "synthetic",
          title: rendered.title, content: rendered.content, metadata: rendered.metadata,
        };
        rows.push(JSON.stringify(artifact));
      }
      await writeFile(path.join(companyDir, `${source}.jsonl`), `${rows.join("\n")}\n`);
    }
    await writeFile(path.join(goldRoot, `${companyId}.json`), `${JSON.stringify(seeds, null, 2)}\n`);
  }
  process.stdout.write(`Generated ${Object.keys(catalog).length} companies × ${Object.values(counts).reduce((a, b) => a + b, 0)} artifacts at scale ${scale}\n`);
}

await main();
