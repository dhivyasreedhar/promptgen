class OperationalMetrics {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; sum: number; max: number }>();

  increment(name: string, labels: Record<string, string> = {}, amount = 1): void {
    const key = metricKey(name, labels); this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }
  observe(name: string, seconds: number, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels); const prior = this.durations.get(key) ?? { count: 0, sum: 0, max: 0 };
    this.durations.set(key, { count: prior.count + 1, sum: prior.sum + seconds, max: Math.max(prior.max, seconds) });
  }
  render(): string {
    const lines = ["# TYPE promptgen_info gauge", "promptgen_info 1"];
    for (const [key, value] of [...this.counters].sort()) lines.push(`${key} ${value}`);
    for (const [key, value] of [...this.durations].sort()) {
      lines.push(`${suffixKey(key, "_count")} ${value.count}`, `${suffixKey(key, "_sum")} ${value.sum.toFixed(6)}`,
        `${suffixKey(key, "_max")} ${value.max.toFixed(6)}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function suffixKey(key: string, suffix: string): string {
  const labelsAt = key.indexOf("{");
  return labelsAt < 0 ? `${key}${suffix}` : `${key.slice(0, labelsAt)}${suffix}${key.slice(labelsAt)}`;
}

function metricKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `${name}{${entries.map(([key, value]) => `${key}="${value.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")}"`).join(",")}}` : name;
}

export const operationalMetrics = new OperationalMetrics();
