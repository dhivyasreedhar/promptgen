import type { CompanyConfig, EvidenceNeed } from "../types.js";

export interface TopicPlan { slug: string; query: string }

export function planEvidenceNeeds(company: CompanyConfig, discoveredTopics: Array<string | TopicPlan>): EvidenceNeed[] {
  const general: EvidenceNeed[] = [
    { id: "category-demand", query: `${company.category} customer problem need evaluating`, kinds: ["demand", "language"], reason: "Find real buyer problems and vocabulary", preferredSources: ["gsc", "intercom", "slack", "calls", "crm"] },
    { id: "capabilities", query: `${company.category} supports provides integration workflow`, kinds: ["capability", "change"], reason: "Establish what the company can credibly solve now", preferredSources: ["web", "github", "linear"] },
    { id: "constraints", query: `${company.category} limitation security scale latency difficult`, kinds: ["constraint", "demand"], reason: "Find buying constraints that shape recommendation prompts", preferredSources: ["intercom", "slack", "github", "calls"] },
    { id: "alternatives", query: `${company.category} alternative versus replace migration evaluating`, kinds: ["comparison", "demand"], reason: "Find comparison and switching situations", preferredSources: ["crm", "calls", "gsc"] },
  ];
  const topical = discoveredTopics.slice(0, 24).map((topic): EvidenceNeed => {
    const slug = typeof topic === "string" ? topic : topic.slug;
    const query = typeof topic === "string" ? topic.replaceAll("-", " ") : topic.query;
    return {
    id: `topic:${slug}`, query, kinds: ["demand", "capability", "constraint", "language"],
    reason: `Build a corroborated evidence pack for ${slug.replaceAll("-", " ")}`,
    preferredSources: ["gsc", "intercom", "slack", "web", "github"],
  }; });
  return [...general, ...topical];
}
