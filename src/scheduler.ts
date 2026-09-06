import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { runDailyCanaries } from "./quality/canary.js";
import { EvidenceDatabase } from "./store/database.js";
import { PostgresMetadataStore } from "./store/postgres-metadata.js";
import { log } from "./util.js";

export async function scheduler(config: AppConfig, fixtures: boolean): Promise<never> {
  const owner = `${process.pid}:${randomUUID()}`;
  log("info", "scheduler.started", { dailyAt: config.dailyAt, timezone: config.timezone, companies: config.companies.map(c => c.id) });
  for (;;) {
    const now = new Date();
    if (isScheduledMinute(now, config.dailyAt, config.timezone)) await runDueCompanies(config, fixtures, owner, now);
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
}

export async function runDueCompanies(config: AppConfig, fixtures: boolean, owner: string, now = new Date()): Promise<void> {
  using db = new EvidenceDatabase(config.dbPath);
  const hosted = config.postgresUrl ? new PostgresMetadataStore(config.postgresUrl, config.tenantId, config.tenantName) : undefined;
  const acquired = hosted ? await hosted.acquireLock("daily-run", owner, now, 4 * 60 * 60_000) : db.acquireLock("daily-run", owner, now, 4 * 60 * 60_000);
  if (!acquired) { await hosted?.close(); log("warn", "scheduler.locked", { owner }); return; }
  const renewal = setInterval(() => {
    if (hosted) void hosted.renewLock("daily-run", owner, new Date(), 4 * 60 * 60_000)
      .catch(error => log("error", "scheduler.renewal-failed", { error: error instanceof Error ? error.message : String(error) }));
    else db.renewLock("daily-run", owner, new Date(), 4 * 60 * 60_000);
  }, 60 * 60_000);
  renewal.unref();
  try {
    const lastCanary = db.latestCanaryReport<{ completedAt: string; state?: string }>();
    const due = !lastCanary || lastCanary.state !== "completed" || now.getTime() - Date.parse(lastCanary.completedAt) >= 20 * 60 * 60_000;
    if (due) await runDailyCanaries(config, fixtures);
  } finally {
    clearInterval(renewal);
    if (hosted) { await hosted.releaseLock("daily-run", owner); await hosted.close(); }
    else db.releaseLock("daily-run", owner);
  }
}

export function isScheduledMinute(now: Date, dailyAt: string, timezone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).reduce<Record<string, string>>((acc, item) => { acc[item.type] = item.value; return acc; }, {});
  return `${parts.hour}:${parts.minute}` === dailyAt;
}
