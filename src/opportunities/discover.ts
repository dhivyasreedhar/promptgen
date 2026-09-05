import type { EvidencePack, Opportunity, SourceType } from "../types.js";
import { stableId } from "../util.js";
import { evidenceBuyerIntent, isBuyingIntent } from "../context/intent.js";

export function discoverOpportunities(companyId: string, packs: EvidencePack[]): Opportunity[] {
  const topical = packs.filter(pack => pack.need.id.startsWith("topic:") && pack.records.length > 0);
  const output: Opportunity[] = [];
  for (const pack of topical) {
    const records = pack.records.map(item => item.evidence);
    const demand = records.filter(record => (record.kind === "demand" || record.kind === "language") && isBuyingIntent(evidenceBuyerIntent(record)));
    const capability = records.filter(record => record.kind === "capability" || (record.kind === "change" && record.lifecycle === "confirmed"));
    if (capability.length === 0) continue;
    const publicInference = demand.length === 0 && records.every(record => record.visibility === "public");
    if (demand.length === 0 && !publicInference) continue;
    const sources = [...new Set(records.map(record => record.source))];
    const topic = pack.need.id.slice("topic:".length);
    output.push({
      id: stableId(companyId, "opportunity", topic), topic,
      buyerProblem: publicInference
        ? `Buyers may evaluate this category for ${topic.replaceAll("-", " ")}; this is inferred from current public product evidence.`
        : bestClaim(demand.map(record => record.claim)),
      segment: records.find(record => record.segment)?.segment ?? "teams evaluating this category",
      evidenceIds: records.map(record => record.id), sources,
      demandScore: publicInference ? 0.2 : aggregate(demand.length, new Set(demand.map(record => record.source)).size),
      capabilityScore: aggregate(capability.length, new Set(capability.map(record => record.source)).size),
      confidence: Math.min(publicInference ? 0.72 : 1, 0.35 + sources.length * 0.1 + Math.min(records.length, 8) * 0.04),
      evidenceBasis: publicInference ? "public-inference" : "observed-demand",
      coverage: {
        audience: records.find(record => record.segment)?.segment ?? "general buyer",
        useCase: topic.replaceAll("-", " "),
        constraint: records.find(record => record.kind === "constraint")?.tags[0]?.replaceAll("-", " ") ?? "none stated",
        decisionStage: publicInference ? "evaluation" : stageFor(demand.map(evidenceBuyerIntent)),
      },
    });
  }
  return output.sort((a, b) => (b.demandScore + b.capabilityScore) - (a.demandScore + a.capabilityScore));
}

function stageFor(intents: ReturnType<typeof evidenceBuyerIntent>[]): "discovery" | "evaluation" | "purchase" {
  if (intents.includes("purchase")) return "purchase";
  if (intents.includes("evaluation")) return "evaluation";
  return "discovery";
}

function bestClaim(claims: string[]): string { return claims.sort((a, b) => a.length - b.length)[0] ?? ""; }
function aggregate(count: number, sourceCount: number): number { return Math.min(1, Math.log1p(count) / 4 + sourceCount * 0.12); }

export function sourceCoverage(opportunities: Opportunity[]): Record<SourceType, number> {
  const result = {} as Record<SourceType, number>;
  for (const opportunity of opportunities) for (const source of opportunity.sources) result[source] = (result[source] ?? 0) + 1;
  return result;
}
