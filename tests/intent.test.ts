import { describe, expect, it } from "vitest";
import { classifyBuyerIntent, isBuyingIntent } from "../src/context/intent.js";

describe("buying-intent classification", () => {
  it("separates account support from product discovery", () => {
    expect(classifyBuyerIntent("How do I reset my Nike password?")).toBe("support");
    expect(isBuyingIntent(classifyBuyerIntent("Which running shoes work well for daily training?"))).toBe(true);
  });

  it("recognizes evaluation and purchase situations", () => {
    expect(classifyBuyerIntent("Which enterprise security vendors should we shortlist?")).toBe("evaluation");
    expect(classifyBuyerIntent("What does this platform cost for procurement?")).toBe("purchase");
    expect(classifyBuyerIntent("Which incident response tools surface the right runbook during an outage?")).toBe("evaluation");
    expect(classifyBuyerIntent("What APIs provide reliable error handling for document parsing?")).toBe("evaluation");
  });
});
