export const SOURCE_TYPES = [
  "web", "github", "gsc", "slack", "intercom", "linear", "crm", "calls", "mintlify",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export type Visibility = "public" | "private" | "synthetic";
export type EvidenceKind = "capability" | "demand" | "constraint" | "comparison" | "language" | "change";
export type RunStatus = "running" | "complete" | "insufficient_evidence" | "failed";
export type EvidenceLifecycle = "confirmed" | "planned" | "investigating" | "deprecated" | "superseded" | "unknown";
export type BuyerIntent = "discovery" | "evaluation" | "purchase" | "implementation" | "support" | "retention" | "irrelevant";
export type PromptOrigin = "observed-question" | "adapted-from-evidence" | "inferred-opportunity" | "customer-authored";
export type FeedbackReason = "wrong-audience" | "unsupported-capability" | "too-niche" | "already-covered" | "not-buying-intent" | "other";

export interface CoverageDimensions {
  audience: string;
  useCase: string;
  constraint: string;
  decisionStage: "discovery" | "evaluation" | "purchase";
}

export interface AccessContext {
  /** Scopes inherited from the authenticated user and source ACL sync. */
  scopes: string[];
}

export interface CompanyConfig {
  id: string;
  name: string;
  domain: string;
  category: string;
  githubOrganizations: string[];
  enabledSources: SourceType[];
}

export interface SourceArtifact {
  id: string;
  companyId: string;
  source: SourceType;
  externalId: string;
  version: string;
  occurredAt: string;
  collectedAt: string;
  visibility: Visibility;
  title: string;
  content: string;
  url?: string;
  metadata: Record<string, unknown>;
}

export interface EvidenceRecord {
  id: string;
  companyId: string;
  artifactId: string;
  source: SourceType;
  visibility: Visibility;
  kind: EvidenceKind;
  claim: string;
  quote: string;
  tags: string[];
  productLine?: string;
  segment?: string;
  confidence: number;
  occurredAt: string;
  extractorVersion: string;
  safeUse: "public" | "derive-only" | "aggregate-only" | "never-expose";
  /** Source-derived access scopes. Retrieval must satisfy at least one scope. */
  aclScopes?: string[];
  /** Whether the statement is current truth, future intent, or no longer true. */
  lifecycle?: EvidenceLifecycle;
  /** Normalized source authority, independent from retrieval relevance. */
  authority?: number;
  validFrom?: string;
  validTo?: string;
  buyerIntent?: BuyerIntent;
}

export interface EvidenceNeed {
  id: string;
  query: string;
  kinds: EvidenceKind[];
  reason: string;
  preferredSources: SourceType[];
}

export interface RankedEvidence {
  evidence: EvidenceRecord;
  score: number;
  reasons: string[];
}

export interface EvidencePack {
  need: EvidenceNeed;
  records: RankedEvidence[];
  missing: boolean;
  reconciliation?: ReconciliationDecision[];
}

export interface ReconciliationDecision {
  action: "semantic-duplicate" | "contradiction-resolved" | "contradiction-unresolved";
  keptEvidenceId?: string;
  removedEvidenceIds: string[];
  reason: string;
}

export interface Opportunity {
  id: string;
  topic: string;
  buyerProblem: string;
  segment: string;
  evidenceIds: string[];
  sources: SourceType[];
  demandScore: number;
  capabilityScore: number;
  confidence: number;
  /** Observed demand is preferred; public inference is a conservative fallback for public-only company analysis. */
  evidenceBasis?: "observed-demand" | "public-inference";
  coverage?: CoverageDimensions;
}

export interface PromptCandidate {
  id: string;
  opportunityId: string;
  text: string;
  archetype: "category" | "comparison" | "constraint" | "workflow" | "boundary";
  evidenceIds: string[];
  version: number;
  parentId?: string;
  evidenceBasis?: "observed-demand" | "public-inference";
  origin?: PromptOrigin;
  coverage?: CoverageDimensions;
  generationMethod?: "model" | "evidence-scaffold";
}

export interface ValidationFinding {
  code: string;
  severity: "info" | "warning" | "fatal";
  message: string;
  evidenceIds?: string[];
}

export interface ValidatedCandidate extends PromptCandidate {
  accepted: boolean;
  score: number;
  findings: ValidationFinding[];
  semanticKey?: string;
}

export interface TrackingPrompt {
  id: string;
  text: string;
  archetype: PromptCandidate["archetype"];
  opportunityId: string;
  evidenceIds: string[];
  score: number;
  semanticKey?: string;
  origin: PromptOrigin;
  coverage: CoverageDimensions;
  set: "benchmark" | "discovery";
}

export interface MissingEvidence {
  need: string;
  reason: string;
  recommendedSources: SourceType[];
}

export interface RunResult {
  schemaVersion: 1;
  runId: string;
  companyId: string;
  companyName: string;
  domain: string;
  status: Exclude<RunStatus, "running">;
  startedAt: string;
  completedAt: string;
  provider: string;
  /** Explicit run mode; UI must not infer this from the surviving citations. */
  contextMode?: "public" | "connected";
  buildVersion?: string;
  discoveryPrompts: TrackingPrompt[];
  boundaryPrompts: TrackingPrompt[];
  benchmarkPrompts?: TrackingPrompt[];
  missingEvidence: MissingEvidence[];
  metrics: {
    artifactsIngested: number;
    evidenceExtracted: number;
    evidenceRetrieved: number;
    opportunities: number;
    candidatesGenerated: number;
    candidatesAccepted: number;
  };
  tracePath: string;
  warnings: string[];
  promptLifecycle?: { added: number; retained: number; removed: number; churnRate: number };
  coverage?: { audiences: string[]; useCases: string[]; constraints: string[]; decisionStages: string[]; missing: string[] };
  failure?: { class: "transient" | "configuration" | "authentication" | "validation" | "cancelled" | "unknown"; retryable: boolean };
  error?: string;
}

export interface TraceEvent {
  at: string;
  runId: string;
  companyId: string;
  stage: string;
  action: string;
  subjectId?: string;
  data: Record<string, unknown>;
}

export interface Connector {
  readonly source: SourceType;
  collect(company: CompanyConfig, signal: AbortSignal): AsyncIterable<SourceArtifact>;
}

export type SourceHealthStatus = "healthy" | "empty" | "degraded";
export interface SourceHealth {
  companyId: string;
  source: SourceType;
  status: SourceHealthStatus;
  checkedAt: string;
  collectedArtifacts: number;
  changedArtifacts: number;
  lastSuccessAt?: string;
  error?: string;
}

export type RunJobStatus = "queued" | "running" | "complete" | "failed" | "cancelled";
export interface RunJob {
  id: string;
  companyId: string;
  status: RunJobStatus;
  company: CompanyConfig;
  fixtures: boolean;
  createdAt: string;
  attempts?: number;
  startedAt?: string;
  completedAt?: string;
  result?: RunResult;
  error?: string;
}
