import type { AppConfig } from "../config.js";
import type { Connector, SourceType } from "../types.js";
import { FixtureConnector } from "./fixture.js";
import { GitHubConnector } from "./github.js";
import { PublicWebConnector } from "./web.js";

const PRIVATE_FIXTURE_SOURCES: SourceType[] = ["gsc", "slack", "intercom", "linear", "crm", "calls", "mintlify"];

export function buildConnectors(config: AppConfig, fixtures: boolean): Connector[] {
  const connectors: Connector[] = [];
  if (config.publicWeb) {
    connectors.push(new PublicWebConnector(config.maxPublicPages, config.requestTimeoutMs));
    connectors.push(new GitHubConnector(config.githubToken, config.requestTimeoutMs));
  }
  if (fixtures) connectors.push(...PRIVATE_FIXTURE_SOURCES.map(source => new FixtureConnector(source, config.fixturesDir)));
  return connectors;
}
