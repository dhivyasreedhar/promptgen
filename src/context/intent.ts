import type { BuyerIntent, EvidenceRecord } from "../types.js";

const SUPPORT = /\b(reset|forgot|password|log ?in|sign ?in|account locked|refund|invoice|billing error|status page|outage|down|bug|broken|error|exception|troubleshoot|how do i|how to configure|setup issue|support ticket)\b/i;
const IMPLEMENTATION = /\b(install|configure|configuration|api syntax|sdk method|code example|implementation|deploy|migration steps?)\b/i;
const RETENTION = /\b(cancel|cancellation|renew|renewal|downgrade|churn|keep using|contract renewal)\b/i;
const PURCHASE = /\b(price|pricing|cost|budget|procurement|purchase|buy|contract|quote|marketplace)\b/i;
const EVALUATION = /\b(best|compare|comparison|versus|vs\.?|alternative|vendor|platform|tool|solution|evaluate|evaluation|shortlist|should we use|recommend)\b/i;
const DISCOVERY = /\b(what (?:can|should)|which|how can|looking for|need|needs|require|requirement|criterion|struggle|difficult|ways? to|options?)\b/i;

export function classifyBuyerIntent(text: string): BuyerIntent {
  if (SUPPORT.test(text)) return "support";
  if (RETENTION.test(text)) return "retention";
  if (PURCHASE.test(text)) return "purchase";
  if (EVALUATION.test(text)) return "evaluation";
  if (IMPLEMENTATION.test(text)) return "implementation";
  if (DISCOVERY.test(text)) return "discovery";
  return "irrelevant";
}

export function isBuyingIntent(intent: BuyerIntent | undefined): boolean {
  return intent === "discovery" || intent === "evaluation" || intent === "purchase";
}

export function evidenceBuyerIntent(record: Pick<EvidenceRecord, "buyerIntent" | "claim" | "quote">): BuyerIntent {
  return record.buyerIntent ?? classifyBuyerIntent(`${record.claim} ${record.quote}`);
}
