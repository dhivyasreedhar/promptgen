import type { RunResult } from "../types.js";

export function classifyFailure(error: unknown): NonNullable<RunResult["failure"]> {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/cancel|abort/.test(message)) return { class: "cancelled", retryable: false };
  if (/401|403|unauthorized|forbidden|invalid api key|authentication/.test(message)) return { class: "authentication", retryable: false };
  if (/configuration|not configured|unknown company|schema|migration|invalid dimension|not_found_error.*model|model.*not found/.test(message)) return { class: "configuration", retryable: false };
  if (/validation|invalid input|expected a json|evidence contract|foreign key|constraint violation/.test(message)) return { class: "validation", retryable: false };
  if (/timeout|timed out|429|rate limit|econn|socket|network|fetch failed|502|503|504|temporar/.test(message)) return { class: "transient", retryable: true };
  return { class: "unknown", retryable: true };
}
