import { describe, expect, it } from "vitest";
import { selectPrompts } from "../src/prompts/select.js";
import type { ValidatedCandidate } from "../src/types.js";

function candidate(index: number, archetype: ValidatedCandidate["archetype"] = "category"): ValidatedCandidate {
  const situations = ["large repositories", "custom policies", "security findings", "review latency", "legacy migrations", "audit records", "polyglot projects", "developer adoption", "stacked changes", "private deployment", "billing controls", "release planning", "mobile applications", "data residency"];
  return { id: `c${index}`, opportunityId: `o${index}`, text: `Which platform supports ${situations[index % situations.length]} for engineering organizations?`, archetype,
    evidenceIds: [`e${index}`, `e${index}-b`], version: 1, accepted: true, score: 0.9 - index / 100, findings: [] };
}

describe("selectPrompts", () => {
  it("returns exactly ten discovery prompts and keeps boundaries separate", () => {
    const result = selectPrompts([...Array.from({ length: 14 }, (_, i) => candidate(i)), candidate(99, "boundary")]);
    expect(result.discovery).toHaveLength(10);
    expect(result.discovery.every(item => item.archetype !== "boundary")).toBe(true);
    expect(result.boundaries).toHaveLength(1);
  });

  it("does not fabricate when the pool is short", () => {
    expect(selectPrompts(Array.from({ length: 7 }, (_, i) => candidate(i))).discovery).toHaveLength(7);
  });

  it("rejects semantically duplicate candidates supported by overlapping evidence", () => {
    const first = { ...candidate(0), text: "What is the best GitLab code review integration for an engineering team?", evidenceIds: ["shared", "a"] };
    const duplicate = { ...candidate(1), text: "Which AI review tools integrate with GitLab repositories?", evidenceIds: ["shared", "b"] };
    const result = selectPrompts([first, duplicate, ...Array.from({ length: 10 }, (_, i) => candidate(i + 2))]);
    expect(result.discovery.filter(item => /gitlab/i.test(item.text))).toHaveLength(1);
  });

  it("does not spend two final slots on the same named integration facet", () => {
    const first = { ...candidate(0), text: "Which code review tools integrate with GitLab repositories?", evidenceIds: ["a", "b"], semanticKey: "gitlab-code-review-integration" };
    const second = { ...candidate(1), text: "What is the best GitLab review workflow for enterprise teams?", evidenceIds: ["c", "d"], semanticKey: "gitlab-review-workflow" };
    expect(selectPrompts([first, second]).discovery).toHaveLength(1);
  });

  it("keeps different buyer situations that happen to share an integration", () => {
    const response = { ...candidate(0), text: "What tools run incident response natively in Slack channels?", semanticKey: "slack-native-incident-response" };
    const scheduling = { ...candidate(1), text: "Which tools synchronize on-call schedules to Slack user groups?", semanticKey: "on-call-schedule-slack-user-groups" };
    expect(selectPrompts([response, scheduling], 2).discovery).toHaveLength(2);
  });

  it("deduplicates large repository and huge monorepo formulations", () => {
    const first = { ...candidate(0), text: "Which review agents keep context across very large repositories?", semanticKey: "large-repo-context-retention" };
    const duplicate = { ...candidate(1), text: "What review solution avoids losing context in huge monorepos?", semanticKey: "repository-wide-context-monorepo" };
    const result = selectPrompts([first, duplicate]);
    expect(result.discovery).toHaveLength(1);
  });

  it("selects at most one candidate from the same original opportunity", () => {
    const first = { ...candidate(0), opportunityId: "shared-opportunity", semanticKey: "fast-review" };
    const second = { ...candidate(1), opportunityId: "shared-opportunity", semanticKey: "stacked-pull-requests" };
    expect(selectPrompts([first, second]).discovery).toHaveLength(1);
  });

  it("uses a second materially distinct archetype only when needed to reach the target", () => {
    const first = { ...candidate(0), opportunityId: "shared", semanticKey: "security-comparison", archetype: "comparison" as const };
    const second = { ...candidate(1), opportunityId: "shared", semanticKey: "security-workflow", archetype: "workflow" as const };
    expect(selectPrompts([first, second], 2).discovery).toHaveLength(2);
  });

  it("gives approved or brand-losing prompts a bounded stability preference", () => {
    expect(selectPrompts([candidate(0), candidate(1)], 1, new Set(["c1"])).discovery[0]?.id).toBe("c1");
  });

  it("collapses differently worded AI incident automation prompts", () => {
    const first = { ...candidate(0), text: "Which incident platforms have built-in AI automation for coordination?", semanticKey: "ai-incident-coordination" };
    const duplicate = { ...candidate(1), text: "What incident tools use artificial intelligence to automate response workflows?", semanticKey: "automated-response-with-ai" };
    expect(selectPrompts([first, duplicate], 2).discovery).toHaveLength(1);
  });

  it("collapses equivalent end-to-end AI agent run tracing prompts", () => {
    const first = { ...candidate(0), text: "Which observability tools trace every AI agent run end to end so teams can debug failures?", semanticKey: "ai-agent-observability" };
    const duplicate = { ...candidate(1), text: "What platforms trace the full execution of agent runs and show the session where it broke?", semanticKey: "agent-run-debugging" };
    const distinct = { ...candidate(2), text: "What tools catch bad AI agent tool calls and visualize spend across agents?", semanticKey: "agent-tool-call-cost-monitoring" };
    expect(selectPrompts([first, duplicate, distinct], 3).discovery).toHaveLength(2);
  });

  it("collapses browser-to-database and frontend-to-database tracing wording", () => {
    const first = { ...candidate(0), text: "What tools trace frontend performance issues back to slow API calls or database queries?", semanticKey: "frontend-backend-tracing" };
    const duplicate = { ...candidate(1), text: "Which observability tools trace requests from browser to database in one view?", semanticKey: "browser-database-tracing" };
    expect(selectPrompts([first, duplicate], 2).discovery).toHaveLength(1);
  });

  it("keeps one on-prem deployment situation despite different compliance modifiers", () => {
    const first = { ...candidate(0), text: "Which document platforms support VPC, on-premises, and air-gapped deployment?", semanticKey: "enterprise-deployment-options" };
    const duplicate = { ...candidate(1), text: "What document tools can be deployed on-premises with SOC 2 compliance?", semanticKey: "onprem-soc2-deployment" };
    expect(selectPrompts([first, duplicate], 2).discovery).toHaveLength(1);
  });

  it("marks approved stable prompts as benchmark prompts", () => {
    expect(selectPrompts([candidate(0)], 1, new Set(), new Set(["c0"])).discovery[0]?.set).toBe("benchmark");
  });

  it("caps peripheral compliance, pricing, and setup prompts when core workflows are available", () => {
    const core = Array.from({ length: 8 }, (_, index) => candidate(index));
    const peripheral = [
      { ...candidate(8), text: "Which tools publish security reports for procurement teams?" },
      { ...candidate(9), text: "Which platforms offer annual plans with volume discounts?" },
      { ...candidate(10), text: "Which products include a CLI setup wizard?" },
      { ...candidate(11), text: "Which vendors provide GDPR compliance documentation?" },
    ];
    const selected = selectPrompts([...core, ...peripheral], 10).discovery;
    expect(selected).toHaveLength(10);
    expect(selected.filter(item => /security reports|annual plans|wizard|compliance documentation/i.test(item.text))).toHaveLength(2);
  });

  it("collapses multiple setup-wizard formulations", () => {
    const first = { ...candidate(0), text: "Which analytics products include a CLI setup wizard?" };
    const second = { ...candidate(1), text: "What tools offer a wizard for installing analytics?" };
    expect(selectPrompts([first, second], 2).discovery).toHaveLength(1);
  });
});
