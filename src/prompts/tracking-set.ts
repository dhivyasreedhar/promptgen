import type { TrackingPrompt } from "../types.js";

/** Pinned benchmarks take stable precedence; discovery fills the remaining customer-facing slots. */
export function composeTrackingSet(discovery: TrackingPrompt[], benchmarks: TrackingPrompt[], target = 10): {
  discovery: TrackingPrompt[];
  benchmarks: TrackingPrompt[];
} {
  const selectedBenchmarks = dedupe(benchmarks).slice(0, target);
  const reserved = new Set(selectedBenchmarks.flatMap(keys));
  const selectedDiscovery = dedupe(discovery)
    .filter(prompt => keys(prompt).every(key => !reserved.has(key)))
    .slice(0, Math.max(0, target - selectedBenchmarks.length));
  return { discovery: selectedDiscovery, benchmarks: selectedBenchmarks };
}

function dedupe(prompts: TrackingPrompt[]): TrackingPrompt[] {
  const seen = new Set<string>();
  return prompts.filter(prompt => {
    const promptKeys = keys(prompt);
    if (promptKeys.some(key => seen.has(key))) return false;
    promptKeys.forEach(key => seen.add(key));
    return true;
  });
}

function keys(prompt: TrackingPrompt): string[] {
  return [...new Set([prompt.id, prompt.semanticKey, normalize(prompt.text)].filter((value): value is string => Boolean(value)))];
}

function normalize(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}
