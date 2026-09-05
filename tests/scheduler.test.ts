import { describe, expect, it } from "vitest";
import { isScheduledMinute } from "../src/scheduler.js";

describe("isScheduledMinute", () => {
  it("uses the configured timezone", () => {
    const instant = new Date("2026-01-15T10:00:00.000Z");
    expect(isScheduledMinute(instant, "02:00", "America/Los_Angeles")).toBe(true);
    expect(isScheduledMinute(instant, "02:01", "America/Los_Angeles")).toBe(false);
  });
});
