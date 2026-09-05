import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import OpenAI from "openai";
import { transformEvidenceForExternal } from "../privacy/transform.js";
import { evidenceBuyerIntent, isBuyingIntent } from "../context/intent.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { CompanyConfig, EvidenceRecord, Opportunity, PromptCandidate } from "../types.js";
import { stableId } from "../util.js";

const coverageSchema = z.object({
  audience: z.string().min(2).max(80),
  useCase: z.string().min(2).max(100),
  constraint: z.string().min(2).max(100),
  decisionStage: z.enum(["discovery", "evaluation", "purchase"]),
});
const generatedSchema = z.object({
  prompts: z.array(z.object({
    opportunityId: z.string(),
    text: z.string().min(12).max(240),
    archetype: z.enum(["category", "comparison", "constraint", "workflow"]),
    evidenceIds: z.array(z.string()).min(1),
    coverage: coverageSchema,
  })).min(10).max(80),
});
type Generated = z.infer<typeof generatedSchema>;

const jsonSchema: Tool.InputSchema = {
  type: "object", additionalProperties: false, required: ["prompts"],
  properties: {
    prompts: { type: "array", minItems: 10, maxItems: 80, items: {
      type: "object", additionalProperties: false, required: ["opportunityId", "text", "archetype", "evidenceIds", "coverage"],
      properties: {
        opportunityId: { type: "string" }, text: { type: "string", minLength: 12, maxLength: 240 },
        archetype: { type: "string", enum: ["category", "comparison", "constraint", "workflow"] },
        evidenceIds: { type: "array", minItems: 1, items: { type: "string" } },
        coverage: { type: "object", additionalProperties: false, required: ["audience", "useCase", "constraint", "decisionStage"], properties: {
          audience: { type: "string", minLength: 2, maxLength: 80 }, useCase: { type: "string", minLength: 2, maxLength: 100 },
          constraint: { type: "string", minLength: 2, maxLength: 100 }, decisionStage: { type: "string", enum: ["discovery", "evaluation", "purchase"] },
        } },
      },
    } },
  },
};

export interface PromptModel {
  readonly name: string;
  planTopics(company: CompanyConfig, evidence: EvidenceRecord[], signal?: AbortSignal): Promise<Array<{ slug: string; query: string }>>;
  generate(company: CompanyConfig, opportunities: Opportunity[], evidence: Map<string, EvidenceRecord>, signal?: AbortSignal, options?: GenerationOptions): Promise<PromptCandidate[]>;
  review(company: CompanyConfig, candidates: PromptCandidate[], evidence: Map<string, EvidenceRecord>, signal?: AbortSignal): Promise<ModelReview[]>;
}

export interface GenerationOptions { minCandidates?: number; maxCandidates?: number }

export interface ModelReview {
  candidateId: string;
  supported: boolean;
  demandSupported: boolean;
  capabilitySupported: boolean;
  relevantEvidenceIds: string[];
  usable: boolean;
  semanticKey: string;
  score: number;
  findings: string[];
  unsupportedClaims: string[];
}

export function createPromptModel(config: AppConfig): PromptModel {
  const selected = config.modelProvider;
  const anthropic = config.anthropicApiKey ? new AnthropicPromptModel(config.anthropicApiKey, config.anthropicModel, config.modelTimeoutMs) : undefined;
  const openai = config.openaiApiKey ? new OpenAIPromptModel(config.openaiApiKey, config.openaiModel, config.modelTimeoutMs) : undefined;
  if ((selected === "anthropic" || selected === "auto") && anthropic) return openai ? new FailoverPromptModel(anthropic, openai) : anthropic;
  if ((selected === "openai" || selected === "auto") && openai) return anthropic ? new FailoverPromptModel(openai, anthropic) : openai;
  if (selected === "anthropic") throw new Error("ANTHROPIC_API_KEY is required for the Anthropic provider");
  if (selected === "openai") throw new Error("OPENAI_API_KEY is required for the OpenAI provider");
  return new LocalPromptModel();
}

/** Keep a completed retrieval run usable when one external model provider is unavailable. */
export class FailoverPromptModel implements PromptModel {
  readonly name: string;
  constructor(private readonly primary: PromptModel, private readonly fallback: PromptModel) {
    this.name = `failover:${primary.name}->${fallback.name}`;
  }

  async planTopics(company: CompanyConfig, evidence: EvidenceRecord[], signal?: AbortSignal): Promise<Array<{ slug: string; query: string }>> {
    return this.attempt(model => model.planTopics(company, evidence, signal), signal);
  }

  async generate(company: CompanyConfig, opportunities: Opportunity[], evidence: Map<string, EvidenceRecord>, signal?: AbortSignal, options?: GenerationOptions): Promise<PromptCandidate[]> {
    return this.attempt(model => model.generate(company, opportunities, evidence, signal, options), signal);
  }

  async review(company: CompanyConfig, candidates: PromptCandidate[], evidence: Map<string, EvidenceRecord>, signal?: AbortSignal): Promise<ModelReview[]> {
    return this.attempt(model => model.review(company, candidates, evidence, signal), signal);
  }

  private async attempt<T>(operation: (model: PromptModel) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await operation(this.primary);
    } catch (primaryError) {
      if (signal?.aborted) throw primaryError;
      return operation(this.fallback);
    }
  }
}

/** Prefer a different provider for evidence judgment when one is configured. */
export function createReviewModel(config: AppConfig, fallback: PromptModel): PromptModel {
  if (config.openaiApiKey && !fallback.name.startsWith("openai:")) {
    return new OpenAIPromptModel(config.openaiApiKey, config.openaiJudgeModel, config.modelTimeoutMs);
  }
  return fallback;
}

abstract class StructuredPromptModel implements PromptModel {
  abstract readonly name: string;
  protected abstract generateStructured(system: string, user: string, signal?: AbortSignal): Promise<Generated>;
  protected abstract planStructured(system: string, user: string, signal?: AbortSignal): Promise<{ topics: Array<{ slug: string; query: string }> }>;
  protected abstract reviewStructured(system: string, user: string, signal?: AbortSignal): Promise<{ reviews: ModelReview[] }>;

  async planTopics(company: CompanyConfig, evidence: EvidenceRecord[], signal?: AbortSignal): Promise<Array<{ slug: string; query: string }>> {
    if (evidence.length === 0) return [];
    const system = "You plan retrieval for a brand-recommendation prompt generator. Identify 8-20 distinct buyer problems or selection situations supported by the supplied evidence. Use concise kebab-case slugs. Queries should contain vocabulary likely to retrieve both demand and capability evidence. Do not invent unsupported features.";
    const user = `Company: ${company.name}\nCategory: ${company.category}\nEvidence:\n${JSON.stringify(evidence.slice(0, 160).map(externalEvidence).filter(Boolean))}`;
    return (await this.planStructured(system, user, signal)).topics;
  }

  async generate(company: CompanyConfig, opportunities: Opportunity[], evidence: Map<string, EvidenceRecord>, signal?: AbortSignal, options: GenerationOptions = {}): Promise<PromptCandidate[]> {
    if (opportunities.length === 0) return [];
    const allowedOpportunityIds = new Set(opportunities.map(item => item.id));
    const opportunityById = new Map(opportunities.map(item => [item.id, item]));
    const allowedEvidenceIds = new Set(evidence.keys());
    const payload = opportunities.slice(0, 30).map(item => ({
      id: item.id, topic: item.topic, buyerProblem: item.buyerProblem, segment: item.segment,
      demandScore: item.demandScore, capabilityScore: item.capabilityScore, evidenceBasis: item.evidenceBasis ?? "observed-demand",
      evidence: item.evidenceIds.slice(0, 8).map(id => {
        const record = evidence.get(id);
        return record ? externalEvidence(record) : undefined;
      }).filter(Boolean),
    }));
    const system = `You generate natural discovery prompts for an AI brand-recommendation system. Produce concise questions, each ending in a question mark. Every question must naturally invite a product, tool, platform, or vendor recommendation—not merely advice, implementation steps, a definition, or an explanation of why a feature matters. Prefer explicit solution language such as “which tools,” “what platforms,” or “what alternatives.” Prompts should sound like real buyers, omit the tracked company's name, describe a genuine problem or selection criterion, and allow multiple reasonable vendors. At least 70% of the set must concern the company's primary product workflow; include no more than two total security, compliance, privacy, procurement, or deployment questions unless observed buyer demand supports more. Do not turn public legal text, vendor paperwork, marketing assets, documentation availability, or setup wizards into standalone opportunities. For observed-demand opportunities, every prompt must cite at least one demand or customer-language evidence ID and one confirmed capability evidence ID. For public-inference opportunities, conservatively infer an evaluation situation from current public product evidence and cite at least one confirmed public capability record; never present it as an observed customer question. Every material clause—including audience, capability, integration, constraint, performance promise, pricing property, and purchase channel—must be directly supported by a cited record. Remove a modifier or clause when its support is only implied. Planned, investigating, deprecated, superseded, expired, inaccessible, or never-expose evidence is never proof of current capability. Never copy or expose private facts, customer names, metrics, quotes, or internal project names. Use private evidence only to infer generalized language. Assign concise coverage dimensions; do not invent an audience or decision stage absent from the evidence or the wording. Do not produce boundary or negative-control prompts in this call.`;
    const minCandidates = Math.max(10, Math.min(30, options.minCandidates ?? 30));
    const maxCandidates = Math.max(minCandidates, Math.min(50, options.maxCandidates ?? 50));
    const quantity = minCandidates === maxCandidates ? `exactly ${minCandidates}` : `${minCandidates}-${maxCandidates}`;
    const user = `Company: ${company.name}\nCategory: ${company.category}\n\nSupported opportunities and evidence:\n${JSON.stringify(payload)}\n\nReturn ${quantity} candidates covering distinct buyer situations before producing variations. Use only supplied opportunity and evidence IDs. Do not assume capabilities absent from evidence.`;
    const generated = await this.generateStructured(system, user, signal);
    return generated.prompts
      .filter(item => allowedOpportunityIds.has(item.opportunityId) && item.evidenceIds.every(id => allowedEvidenceIds.has(id)))
      .map((item, index) => {
        const evidenceBasis = opportunityById.get(item.opportunityId)?.evidenceBasis ?? "observed-demand";
        return {
          id: stableId(company.id, "candidate", item.opportunityId, item.text, String(index)), opportunityId: item.opportunityId,
          text: item.text.trim(), archetype: item.archetype, evidenceIds: [...new Set(item.evidenceIds)], version: 1,
          evidenceBasis, coverage: evidenceBasis === "public-inference" ? { ...item.coverage, audience: "general buyer" } : item.coverage,
        };
      });
  }

  async review(company: CompanyConfig, candidates: PromptCandidate[], evidence: Map<string, EvidenceRecord>, signal?: AbortSignal): Promise<ModelReview[]> {
    if (candidates.length === 0) return [];
    const system = `You are an independent, strict evaluator for AI brand-recommendation tracking prompts. First decompose each question into every material claim: audience, buyer need, capability, integration, constraint, scale or performance promise, pricing property, purchase channel, and modality. Treat the supplied coverage audience, use case, constraint, and decision stage as claims too. Check every claim against the exact cited excerpts, not merely the company's broad category. Put each unsupported or only-implied prompt clause in unsupportedClaims using a short verbatim phrase; prefix unsupported coverage labels with "coverage:". supported must be false whenever unsupportedClaims is non-empty. Return in relevantEvidenceIds only cited IDs that directly support at least one material claim. demandSupported=true only if relevant demand or customer-language evidence demonstrates that buyers actually have this need. capabilitySupported=true only if relevant current, confirmed capability evidence demonstrates that the tracked company can credibly address the complete capability claim. For evidenceBasis=observed-demand, supported requires both demandSupported and capabilitySupported. For evidenceBasis=public-inference, supported may be true with demandSupported=false only when the prompt is a conservative, plausible evaluation question logically derived from public capability evidence and introduces no unsupported audience, constraint, integration, purchase channel, performance, pricing, or modality. Planned, investigating, deprecated, superseded, expired, inaccessible, or never-expose evidence cannot establish capability. usable=true only when the question sounds like a plausible real buyer query, gives multiple vendors a fair chance, and is likely to produce a recommendation for the company's primary product category. Vendor paperwork, public reports, documentation availability, setup wizards, generic compliance guidance, and marketing assets are not useful standalone tracking prompts. Questions asking only how important something is, why it matters, how to implement it, or what process to follow are unusable. Assign a concise kebab-case semanticKey describing the underlying buyer opportunity; semantically equivalent prompts must receive the same key. Score 0-1. Do not reward fluent wording when evidence is weak.`;
    const batches: PromptCandidate[][] = [];
    for (let offset = 0; offset < candidates.length; offset += 8) batches.push(candidates.slice(offset, offset + 8));
    const reviews: ModelReview[] = [];
    // Small concurrent responses are both faster and substantially less likely
    // to omit candidates from a structured array.
    for (let offset = 0; offset < batches.length; offset += 4) {
      const group = batches.slice(offset, offset + 4);
      const completed = await Promise.all(group.map(async batch => {
        const payload = batch.map(candidate => ({
          id: candidate.id, text: candidate.text, archetype: candidate.archetype, evidenceBasis: candidate.evidenceBasis ?? "observed-demand",
          coverage: candidate.coverage,
          evidence: candidate.evidenceIds.map(id => {
            const record = evidence.get(id);
            return record ? externalEvidence(record) : undefined;
          }).filter(Boolean),
        }));
        try {
          const requestedIds = new Set(batch.map(candidate => candidate.id));
          const returned = (await this.reviewStructured(system,
            `Company: ${company.name}\nCategory: ${company.category}\nReturn exactly one review for each of these ${batch.length} candidate IDs: ${[...requestedIds].join(", ")}\nCandidates:\n${JSON.stringify(payload)}`, signal)).reviews
            .filter(review => requestedIds.has(review.candidateId));
          const byId = new Map(returned.map(review => [review.candidateId, review]));
          const missing = batch.filter(candidate => !byId.has(candidate.id));
          if (missing.length > 0) {
            const retryPayload = payload.filter(item => missing.some(candidate => candidate.id === item.id));
            const retried = (await this.reviewStructured(system,
              `Return exactly one review for every candidate. Missing IDs: ${missing.map(item => item.id).join(", ")}\nCompany: ${company.name}\nCategory: ${company.category}\nCandidates:\n${JSON.stringify(retryPayload)}`, signal)).reviews;
            for (const review of retried) if (requestedIds.has(review.candidateId)) byId.set(review.candidateId, review);
          }
          return [...byId.values()];
        } catch {
          // A provider occasionally violates its own tool schema. Preserve the
          // deterministic safety gates and make the degraded critic visible.
          return batch.map(candidate => fallbackReview(candidate, evidence));
        }
      }));
      reviews.push(...completed.flat());
    }
    return reviews;
  }
}

function externalEvidence(record: EvidenceRecord): ReturnType<typeof transformEvidenceForExternal>["evidence"] {
  return transformEvidenceForExternal(record).evidence;
}

function fallbackReview(candidate: PromptCandidate, evidence: Map<string, EvidenceRecord>): ModelReview {
  const relevantEvidenceIds = candidate.evidenceIds.filter(id => evidence.has(id));
  const records = relevantEvidenceIds.map(id => evidence.get(id)!);
  const demandSupported = records.some(record => (record.kind === "demand" || record.kind === "language") && isBuyingIntent(evidenceBuyerIntent(record)));
  const capabilitySupported = records.some(record => record.kind === "capability" || (record.kind === "change" && record.lifecycle === "confirmed"));
  // Claim-level support cannot be reconstructed safely from a malformed model
  // response. Fail closed instead of allowing broad category overlap through.
  return { candidateId: candidate.id, supported: false, demandSupported, capabilitySupported,
    relevantEvidenceIds, usable: false, semanticKey: candidate.opportunityId, score: 0,
    findings: ["provider-review-schema-fallback"], unsupportedClaims: ["atomic claim review unavailable"] };
}

class AnthropicPromptModel extends StructuredPromptModel {
  readonly name: string;
  private readonly client: Anthropic;
  constructor(apiKey: string, private readonly model: string, timeout: number) { super(); this.client = new Anthropic({ apiKey, timeout, maxRetries: 2 }); this.name = `anthropic:${model}`; }
  protected async generateStructured(system: string, user: string, signal?: AbortSignal): Promise<Generated> {
    const response = await this.client.messages.create({
      model: this.model, max_tokens: 8_000, system, messages: [{ role: "user", content: user }],
      tools: [{ name: "submit_prompts", description: "Submit the generated tracking prompt candidates.", input_schema: jsonSchema }],
      tool_choice: { type: "tool", name: "submit_prompts", disable_parallel_tool_use: true },
    }, { signal });
    const tool = response.content.find(block => block.type === "tool_use");
    if (!tool || tool.type !== "tool_use") throw new Error("Anthropic returned no structured prompt payload");
    return parseAnthropicGenerated(tool.input);
  }
  protected async planStructured(system: string, user: string, signal?: AbortSignal): Promise<{ topics: Array<{ slug: string; query: string }> }> {
    const schema: Tool.InputSchema = {
      type: "object",
      required: ["topics"],
      properties: {
        topics: {
          type: "array", minItems: 1, maxItems: 20,
          items: {
            type: "object", required: ["slug", "query"],
            properties: { slug: { type: "string" }, query: { type: "string" } },
          },
        },
      },
    };
    const response = await this.client.messages.create({ model: this.model, max_tokens: 3_000, system, messages: [{ role: "user", content: user }], tools: [{ name: "submit_topics", input_schema: schema }], tool_choice: { type: "tool", name: "submit_topics", disable_parallel_tool_use: true } }, { signal });
    const tool = response.content.find(block => block.type === "tool_use");
    if (!tool || tool.type !== "tool_use") throw new Error("Anthropic returned no topic plan");
    return topicPlanSchema.parse(normalizeAnthropicPayload(tool.input, "topics"));
  }
  protected async reviewStructured(system: string, user: string, signal?: AbortSignal): Promise<{ reviews: ModelReview[] }> {
    let lastFailure: z.ZodError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retryInstruction = attempt === 0 ? system : `${system}\nIMPORTANT: The reviews property must be a JSON array, never a string containing JSON or prose.`;
      const response = await this.client.messages.create({ model: this.model, max_tokens: 8_000, system: retryInstruction, messages: [{ role: "user", content: user }], tools: [{ name: "submit_reviews", input_schema: reviewToolSchema }], tool_choice: { type: "tool", name: "submit_reviews", disable_parallel_tool_use: true } }, { signal });
      const tool = response.content.find(block => block.type === "tool_use");
      if (!tool || tool.type !== "tool_use") continue;
      const parsed = reviewSchema.safeParse(normalizeAnthropicPayload(tool.input, "reviews"));
      if (parsed.success) return parsed.data;
      lastFailure = parsed.error;
    }
    throw lastFailure ?? new Error("Anthropic returned no candidate reviews");
  }
}

class OpenAIPromptModel extends StructuredPromptModel {
  readonly name: string;
  private readonly client: OpenAI;
  constructor(apiKey: string, private readonly model: string, timeout: number) { super(); this.client = new OpenAI({ apiKey, timeout, maxRetries: 2 }); this.name = `openai:${model}`; }
  protected async generateStructured(system: string, user: string, signal?: AbortSignal): Promise<Generated> {
    const response = await this.client.responses.create({
      model: this.model, instructions: system, input: user,
      text: { format: { type: "json_schema", name: "tracking_prompts", schema: jsonSchema, strict: true } },
    }, { signal });
    if (!response.output_text) throw new Error("OpenAI returned no structured prompt payload");
    return generatedSchema.parse(JSON.parse(response.output_text) as unknown);
  }
  protected async planStructured(system: string, user: string, signal?: AbortSignal): Promise<{ topics: Array<{ slug: string; query: string }> }> {
    const response = await this.client.responses.create({ model: this.model, instructions: system, input: user, text: { format: { type: "json_schema", name: "topic_plan", schema: topicPlanJsonSchema, strict: true } } }, { signal });
    if (!response.output_text) throw new Error("OpenAI returned no topic plan");
    return topicPlanSchema.parse(JSON.parse(response.output_text) as unknown);
  }
  protected async reviewStructured(system: string, user: string, signal?: AbortSignal): Promise<{ reviews: ModelReview[] }> {
    const response = await this.client.responses.create({ model: this.model, instructions: system, input: user, text: { format: { type: "json_schema", name: "candidate_reviews", schema: reviewJsonSchema, strict: true } } }, { signal });
    if (!response.output_text) throw new Error("OpenAI returned no candidate reviews");
    return reviewSchema.parse(JSON.parse(response.output_text) as unknown);
  }
}

const localPrompts: Record<string, Record<string, string[]>> = {
  greptile: {
    "large-repositories": ["What are the best AI code review tools for very large monorepos?", "Which code review agents can understand dependencies across an entire repository?"],
    "review-noise": ["Which AI code review tools produce the fewest low-value comments?", "How can I automate pull request reviews without overwhelming developers with false positives?"],
    "custom-rules": ["Which AI code review tools can enforce a company's internal engineering standards?", "What code review agents support custom rules for regulated software teams?"],
    gitlab: ["What are the best AI code review tools for teams using GitLab?", "Which automated code reviewers work with private GitLab repositories?"],
    security: ["Which AI code review platforms are best at finding security issues in pull requests?"],
    "on-prem": ["What AI code review tools can run in company-controlled infrastructure?"],
    "review-speed": ["What tools can reduce pull request review time for fast-moving engineering teams?"],
    "legacy-code": ["Which AI tools help reviewers understand changes in unfamiliar legacy codebases?"],
    "developer-adoption": ["What AI code review tools give actionable feedback developers will trust?"],
    compliance: ["Which automated code review platforms provide auditable review records?"],
    "multi-language": ["What AI code review tools work well across polyglot repositories?"],
  },
  rootly: {
    "slack-incidents": ["What are the best Slack-native incident management platforms?", "How can an SRE team coordinate incidents without losing decisions across Slack threads?"],
    "on-call": ["Which incident management tools combine on-call escalation with response coordination?"],
    postmortems: ["What incident management platforms automatically build useful postmortem timelines?"],
    runbooks: ["Which incident response tools surface the right runbook during an outage?"],
    "status-pages": ["What tools keep customer status updates synchronized with incident response?"],
    "pagerduty-migration": ["What are good incident management alternatives for teams outgrowing paging-only workflows?"],
    automation: ["Which incident management platforms automate repetitive coordination work?"],
    "multi-team": ["What incident response tools work best for complex cross-team outages?"],
    metrics: ["Which incident management platforms provide strong MTTR and process analytics?"],
    "security-incidents": ["What incident management tools support restricted security incident collaboration?"],
    "jira-sync": ["Which incident platforms reliably turn follow-up actions into Jira work?"],
    "ai-summaries": ["What tools can summarize high-volume incident channels for incoming responders?"],
  },
  reducto: {
    "complex-pdfs": ["What are the best document parsing APIs for complex multi-column PDFs?", "Which document intelligence tools preserve layout when parsing PDFs for AI applications?"],
    tables: ["Which document extraction APIs handle tables with merged cells and nested headers?"],
    "scanned-docs": ["What document processing tools provide reliable OCR for low-quality scanned PDFs?"],
    handwriting: ["Which document AI platforms can extract mixed handwritten and printed form fields?"],
    "rag-ingestion": ["What document ingestion tools preserve citations and layout context for RAG?"],
    "schema-output": ["Which document extraction APIs can normalize different layouts into a fixed JSON schema?"],
    "batch-scale": ["What document parsing platforms handle large asynchronous batch workloads?"],
    "financial-docs": ["Which document AI tools work best for dense financial reports and footnotes?"],
    forms: ["What OCR APIs reliably extract checkboxes and structured form fields?"],
    "api-reliability": ["Which document parsing APIs provide reliable job status, retries, and error handling?"],
    "image-docs": ["What document intelligence platforms can understand charts and images alongside text?"],
    "data-residency": ["Which document extraction platforms support sensitive enterprise documents and data controls?"],
  },
  supermemory: {
    "cross-session": ["What are the best memory platforms for AI assistants that need context across sessions?", "How can I give an AI assistant persistent user memory without building it from scratch?"],
    "user-profiles": ["Which agent memory APIs can maintain changing user preferences over time?"],
    "memory-retrieval": ["What AI memory systems retrieve relevant context from long conversation histories?"],
    "memory-api": ["Which managed memory APIs are easiest to add to an existing AI application?"],
    "multi-agent": ["What memory infrastructure lets multiple agents share user context safely?"],
    deduplication: ["Which AI memory systems consolidate repeated or duplicate memories?"],
    forgetting: ["What agent memory platforms support updating and forgetting stale user information?"],
    latency: ["Which memory APIs have low enough retrieval latency for interactive AI assistants?"],
    multimodal: ["What memory systems can ingest links and documents alongside conversations?"],
    privacy: ["Which AI memory platforms support user-level deletion and privacy controls?"],
    frameworks: ["What memory infrastructure works across multiple agent frameworks and SDKs?"],
    observability: ["Which agent memory tools explain why a particular memory was recalled?"],
  },
};

class LocalPromptModel implements PromptModel {
  readonly name = "local:deterministic-development-provider";
  async planTopics(_company: CompanyConfig, evidence: EvidenceRecord[]): Promise<Array<{ slug: string; query: string }>> {
    return [...new Set(evidence.flatMap(record => record.tags))].filter(tag => tag !== "operations").slice(0, 24).map(slug => ({ slug, query: slug.replaceAll("-", " ") }));
  }
  async generate(company: CompanyConfig, opportunities: Opportunity[]): Promise<PromptCandidate[]> {
    const prompts = localPrompts[company.id] ?? {};
    return opportunities.flatMap(opportunity => (prompts[opportunity.topic] ?? []).map((text, index) => ({
      id: stableId(company.id, "local", opportunity.id, text), opportunityId: opportunity.id, text,
      archetype: index % 2 === 0 ? "category" as const : "workflow" as const,
      evidenceIds: opportunity.evidenceIds.slice(0, 6), version: 1, evidenceBasis: opportunity.evidenceBasis ?? "observed-demand",
    })));
  }
  async review(_company: CompanyConfig, candidates: PromptCandidate[]): Promise<ModelReview[]> {
    return candidates.map(candidate => ({ candidateId: candidate.id, supported: true, demandSupported: true, capabilitySupported: true,
      relevantEvidenceIds: candidate.evidenceIds, usable: true, semanticKey: candidate.opportunityId, score: 0.85,
      findings: [], unsupportedClaims: [] }));
  }
}

const topicPlanSchema = z.object({ topics: z.array(z.object({ slug: z.string().regex(/^[a-z0-9-]+$/), query: z.string().min(3).max(200) })).min(1).max(20) });
const topicPlanJsonSchema = {
  type: "object", additionalProperties: false, required: ["topics"], properties: {
    topics: {
      type: "array", minItems: 1, maxItems: 20,
      items: {
        type: "object", additionalProperties: false, required: ["slug", "query"],
        properties: { slug: { type: "string", pattern: "^[a-z0-9-]+$" }, query: { type: "string", minLength: 3, maxLength: 200 } },
      },
    },
  },
};

const reviewSchema = z.object({ reviews: z.array(z.object({
  candidateId: z.string(), supported: z.boolean(), demandSupported: z.boolean(), capabilitySupported: z.boolean(),
  relevantEvidenceIds: z.array(z.string()).max(8), usable: z.boolean(), semanticKey: z.string().regex(/^[a-z0-9-]+$/),
  score: z.number().min(0).max(1), findings: z.array(z.string().max(240)).max(8),
  unsupportedClaims: z.array(z.string().min(1).max(160)).max(12),
})).max(80) });
const reviewJsonSchema: Tool.InputSchema = {
  type: "object", additionalProperties: false, required: ["reviews"], properties: {
    reviews: { type: "array", maxItems: 80, items: { type: "object", additionalProperties: false, required: ["candidateId", "supported", "demandSupported", "capabilitySupported", "relevantEvidenceIds", "usable", "semanticKey", "score", "findings", "unsupportedClaims"], properties: {
      candidateId: { type: "string" }, supported: { type: "boolean" }, demandSupported: { type: "boolean" }, capabilitySupported: { type: "boolean" }, relevantEvidenceIds: { type: "array", maxItems: 8, items: { type: "string" } }, usable: { type: "boolean" }, semanticKey: { type: "string", pattern: "^[a-z0-9-]+$" }, score: { type: "number", minimum: 0, maximum: 1 }, findings: { type: "array", maxItems: 8, items: { type: "string", maxLength: 240 } },
      unsupportedClaims: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 160 } },
    } } },
  },
};
const reviewToolSchema = reviewJsonSchema;

export function normalizeAnthropicPayload(input: unknown, key: "topics" | "prompts" | "reviews"): unknown {
  let current = decodeJsonLayers(input);
  for (let depth = 0; depth < 10; depth += 1) {
    if (Array.isArray(current)) return { [key]: current };
    if (!current || typeof current !== "object") return input;
    const container = current as Record<string, unknown>;
    const value = decodeJsonLayers(container[key]);
    if (Array.isArray(value)) return { ...container, [key]: value };
    if (value && typeof value === "object") { current = value; continue; }
    return current;
  }
  return input;
}

function decodeJsonLayers(input: unknown): unknown {
  let value = input;
  for (let depth = 0; depth < 10 && typeof value === "string"; depth += 1) {
    const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { value = JSON.parse(trimmed) as unknown; }
    catch {
      const starts = [trimmed.indexOf("["), trimmed.indexOf("{")].filter(index => index >= 0);
      const start = starts.length ? Math.min(...starts) : -1;
      const end = Math.max(trimmed.lastIndexOf("]"), trimmed.lastIndexOf("}"));
      if (start < 0 || end <= start) return value;
      try { value = JSON.parse(trimmed.slice(start, end + 1)) as unknown; } catch { return value; }
    }
  }
  return value;
}

function parseAnthropicGenerated(input: unknown): Generated {
  const normalized = normalizeAnthropicPayload(input, "prompts");
  if (!normalized || typeof normalized !== "object" || !Array.isArray((normalized as Record<string, unknown>).prompts)) {
    throw new Error("Anthropic returned an invalid prompts payload");
  }
  const aliases: Record<string, string> = {
    capability: "category", recommendation: "category", discovery: "category",
    "use-case": "workflow", use_case: "workflow", problem: "workflow",
  };
  const prompts = ((normalized as Record<string, unknown>).prompts as unknown[]).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const record = { ...(item as Record<string, unknown>) };
    if (typeof record.archetype === "string" && aliases[record.archetype]) record.archetype = aliases[record.archetype];
    const parsed = generatedSchema.shape.prompts.element.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
  return generatedSchema.parse({ prompts });
}
