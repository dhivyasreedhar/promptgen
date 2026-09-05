import type { BuyerIntent, EvidenceRecord } from "../types.js";

const SUPPORT = /\b(reset|forgot|password|log ?in|sign ?in|account locked|refund|invoice|billing error|status page|outage|down|bug|broken|error|exception|troubleshoot|how do i|how to configure|setup issue|support ticket)\b/i;
const IMPLEMENTATION = /\b(install|configure|configuration|api syntax|sdk method|code example|implementation|deploy|migration steps?)\b/i;
const RETENTION = /\b(cancel|cancellation|renew|renewal|downgrade|churn|keep using|contract renewal)\b/i;
const PURCHASE = /\b(price|pricing|cost|budget|procurement|purchase|buy|contract|quote|marketplace)\b/i;
const EVALUATION = /\b(best|compare|comparison|versus|vs\.?|alternative|vendor|platform|tool|api|infrastructure|agent|reviewer|solution|system|service|software|product|provider|app|evaluate|evaluation|shortlist|should we use|recommend)s?\b/i;
const DISCOVERY = /\b(what (?:can|should)|which|how can|looking for|need|needs|require|requirement|criterion|struggle|difficult|ways? to|options?)\b/i;
const FIRST_PERSON_SUPPORT = /^(?:how do i|how can i|why (?:is|does) my|my account)\b/i;

export function classifyBuyerIntent(text: string): BuyerIntent {
  if (PURCHASE.test(text)) return "purchase";
  // Product-category language signals vendor selection even when the use case
  // contains words such as incident, error, configuration, or debugging.
  if (EVALUATION.test(text) && !FIRST_PERSON_SUPPORT.test(text)) return "evaluation";
  if (SUPPORT.test(text)) return "support";
  if (RETENTION.test(text)) return "retention";
  if (IMPLEMENTATION.test(text)) return "implementation";
  if (DISCOVERY.test(text)) return "discovery";
  return "irrelevant";
}

export function isBuyingIntent(intent: BuyerIntent | undefined): boolean {
  return intent === "discovery" || intent === "evaluation" || intent === "purchase";
}

export function isBuyingSignal(record: Pick<EvidenceRecord, "kind" | "buyerIntent" | "claim" | "quote">): boolean {
  return ["demand", "language", "constraint", "comparison"].includes(record.kind) && isBuyingIntent(evidenceBuyerIntent(record));
}

export function evidenceBuyerIntent(record: Pick<EvidenceRecord, "buyerIntent" | "claim" | "quote">): BuyerIntent {
  return record.buyerIntent ?? classifyBuyerIntent(`${record.claim} ${record.quote}`);
}
