import type { CompanyConfig, Opportunity, PromptCandidate } from "../types.js";
import { stableId } from "../util.js";

/**
 * Produce a conservative candidate for every retrieved opportunity. The model
 * still supplies the more natural candidates, but a provider that returns too
 * few items (or invents unsupported modifiers) can no longer starve selection.
 * These candidates make exactly two claims: the configured product category
 * and the evidence-derived topic. They still pass through repair, deterministic
 * validation, and the independent reviewer before they can be selected.
 */
export function scaffoldCandidates(company: CompanyConfig, opportunities: Opportunity[]): PromptCandidate[] {
  const category = categoryPhrase(company.category);
  const companyTokens = new Set([company.name.toLowerCase(), company.domain.split(".")[0]!.toLowerCase()]);
  return opportunities.filter(opportunity => {
    const terms = humanTopic(opportunity.topic).toLowerCase().split(" ").filter(Boolean);
    return terms.length >= 2 && !terms.some(term => companyTokens.has(term)) &&
      !/^(?:customers?|case studies?|testimonials?)\b/i.test(humanTopic(opportunity.topic)) &&
      !/\b(?:free|demo|trial|signup|sign-up|pricing|contact sales|book demo)\b/i.test(humanTopic(opportunity.topic));
  }).map(opportunity => {
    const topic = humanTopic(opportunity.topic);
    const text = scaffoldText(category, topic);
    return {
      id: stableId(company.id, "evidence-scaffold", opportunity.id, text),
      opportunityId: opportunity.id,
      text,
      archetype: "category",
      evidenceIds: opportunity.evidenceIds.slice(0, 8),
      version: 1,
      evidenceBasis: opportunity.evidenceBasis ?? "observed-demand",
      generationMethod: "evidence-scaffold",
      // Scaffolds intentionally avoid inferred audience and constraint labels.
      // Those dimensions often originate in adjacent retrieved records and can
      // turn a supported topic into an over-specific claim.
      coverage: {
        audience: "general buyer",
        useCase: topic,
        constraint: "none stated",
        decisionStage: opportunity.coverage?.decisionStage ?? "evaluation",
      },
    };
  });
}

function scaffoldText(category: string, topic: string): string {
  const alternative = topic.match(/^vs\s+(.+)$/i)?.[1];
  if (alternative) return `What are the best alternatives to ${displayName(alternative)} among ${category}?`;
  // Topic planners sometimes return a search-query label rather than a buyer
  // need. Do not paste that label after "best for" verbatim.
  if (/\b(?:platform|product|vendor|tool)?\s*comparison$/i.test(topic)) return `Which ${category} should buyers compare?`;
  return `Which ${category} should buyers evaluate for ${topic}?`;
}

function displayName(value: string): string {
  return value.split(/\s+/).map(part => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function humanTopic(topic: string): string {
  return topic.replaceAll("-", " ").replaceAll(/\s+/g, " ").trim();
}

function categoryPhrase(category: string): string {
  const normalized = category.trim().replace(/\.$/, "");
  if (/^company or product$/i.test(normalized)) return "software platforms";
  const infrastructure = normalized.match(/^(.+?) infrastructure for (.+?) applications$/i);
  if (infrastructure) return `${infrastructure[2]} application ${infrastructure[1]} platforms`;
  if (/\bplatform$/i.test(normalized)) return normalized.replace(/platform$/i, "platforms");
  if (/\btool$/i.test(normalized)) return normalized.replace(/tool$/i, "tools");
  if (/\bapi$/i.test(normalized)) return normalized.replace(/api$/i, "APIs");
  if (/\b(?:analytics|software|infrastructure|management)$/i.test(normalized)) return `${normalized} products`;
  return `${normalized} tools`;
}
