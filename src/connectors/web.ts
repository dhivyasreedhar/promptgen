import type { CompanyConfig, Connector, SourceArtifact } from "../types.js";
import { hash, isoNow, normalizeText, stableId } from "../util.js";

const CORE_PATHS = ["/", "/product", "/platform", "/features", "/pricing", "/docs", "/solutions", "/customers", "/integrations", "/security"];
const CORE_SEGMENT = /^\/(docs?|documentation|pricing|product|products|platforms?|features?|solutions?|use-cases?|for|customers?|case-stud(?:y|ies)|security|integrations?|changelog|about)(\/|$)/i;
const LOW_SIGNAL = /^\/(blog|handbook|newsletter|careers?|jobs?|legal|terms|privacy)(\/|$)/i;
const NON_HTML = /\.(?:avif|css|gif|ico|jpe?g|js|json|map|mp4|pdf|png|svg|webm|webp|woff2?|xml)$/i;
const NON_CONTENT_DESTINATION = /^\/(?:auth|account|dashboard|login|sign-?up)(?:\/|$)/i;

export class PublicWebConnector implements Connector {
  readonly source = "web" as const;
  constructor(private readonly maxPages: number, private readonly timeoutMs: number) {}

  async *collect(company: CompanyConfig, signal: AbortSignal): AsyncIterable<SourceArtifact> {
    const origin = `https://${company.domain}`;
    const urls = await this.discover(origin, company.domain, signal);
    const requestLimit = Math.min(urls.length, Math.max(24, this.maxPages * 3));
    let collected = 0;
    const seenCanonical = new Set<string>();
    // Public pages are independent. Small parallel batches keep the fast path
    // responsive without behaving like an aggressive crawler. Keep trying
    // ranked candidates until maxPages *successful* pages are collected;
    // missing conventional paths must not consume the useful-page budget.
    for (let offset = 0; offset < requestLimit && collected < this.maxPages; offset += 4) {
      const batch = urls.slice(offset, Math.min(requestLimit, offset + 4));
      const artifacts = await Promise.all(batch.map(url => this.fetchArtifact(company, url, signal)));
      for (const artifact of artifacts) {
        if (!artifact || seenCanonical.has(artifact.externalId)) continue;
        seenCanonical.add(artifact.externalId);
        collected += 1;
        yield artifact;
        if (collected >= this.maxPages) break;
      }
    }
  }

  private async fetchArtifact(company: CompanyConfig, url: string, signal: AbortSignal): Promise<SourceArtifact | undefined> {
    // A single malformed, truncated, or prematurely closed response must not
    // discard the other successfully fetched pages in this crawl batch.
    try {
      const response = await safeFetch(url, company.domain, this.timeoutMs, signal);
      if (!response.ok) return undefined;
      const html = await response.text();
      const content = htmlToText(html);
      if (content.length < 120) return undefined;
      const canonicalUrl = new URL(response.url);
      if (NON_CONTENT_DESTINATION.test(canonicalUrl.pathname)) return undefined;
      canonicalUrl.hash = "";
      canonicalUrl.search = "";
      const canonical = canonicalUrl.href;
      const version = hash(content).slice(0, 16);
      return {
        id: stableId(company.id, "web", canonical, version), companyId: company.id, source: "web",
        externalId: canonical, version, occurredAt: response.headers.get("last-modified") ?? isoNow(),
        collectedAt: isoNow(), visibility: "public", title: extractTitle(html) || canonical,
        content: content.slice(0, 80_000), url: canonical,
        metadata: { contentType: response.headers.get("content-type"), etag: response.headers.get("etag") },
      };
    } catch {
      return undefined;
    }
  }

  private async discover(origin: string, domain: string, signal: AbortSignal): Promise<string[]> {
    const candidates = new Set<string>(CORE_PATHS.map(pathname => new URL(pathname, origin).href));
    // Many modern sites have no usable sitemap (or serve a very large one),
    // while their homepage navigation names the canonical product pages.
    try {
      const response = await safeFetch(origin, domain, this.timeoutMs, signal);
      if (response.ok) {
        const html = await response.text();
        for (const match of html.matchAll(/\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
          const value = match[1]?.replaceAll("&amp;", "&");
          if (!value) continue;
          try {
            const url = new URL(value, response.url || origin);
            url.hash = "";
            url.search = "";
            if (isAllowedHost(url, domain) && !NON_HTML.test(url.pathname)) candidates.add(url.href);
          } catch { /* malformed navigation link */ }
        }
      }
    } catch { /* homepage links are an optional discovery hint */ }
    for (const sitemapPath of ["/sitemap.xml", "/sitemap_index.xml"]) {
      try {
        const response = await safeFetch(`${origin}${sitemapPath}`, domain, this.timeoutMs, signal);
        if (!response.ok) continue;
        const xml = await response.text();
        for (const match of xml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)) {
          const value = match[1]?.replaceAll("&amp;", "&");
          if (!value) continue;
          try {
            const url = new URL(value);
            if (isAllowedHost(url, domain) && !/\.(xml|jpg|jpeg|png|gif|svg|pdf)$/i.test(url.pathname)) candidates.add(url.href);
          } catch { /* malformed sitemap entry */ }
        }
      } catch {
        // Sitemaps are optional discovery hints. A bad sitemap must not block
        // the deterministic core product pages from being collected.
        continue;
      }
    }
    return rankPublicUrls([...candidates]);
  }
}

/** Prefer first-party product truth over high-volume editorial and company-handbook pages. */
export function rankPublicUrls(urls: string[]): string[] {
  return [...new Set(urls)].sort((left, right) => publicUrlScore(right) - publicUrlScore(left) || left.localeCompare(right));
}

function publicUrlScore(value: string): number {
  const pathname = new URL(value).pathname.replace(/\/$/, "") || "/";
  if (pathname === "/") return 120;
  if (["/product", "/platform", "/features", "/solutions"].includes(pathname)) return 115;
  if (["/docs", "/integrations"].includes(pathname)) return 100;
  if (/^\/(?:product|products|features|platforms?)(?:\/|$)/i.test(pathname)) return 96 - Math.min(18, pathname.split("/").length * 2);
  if (/^\/(?:solutions?|use-cases?)(?:\/|$)/i.test(pathname)) return 92 - Math.min(18, pathname.split("/").length * 2);
  if (/^\/for(?:\/|$)/i.test(pathname)) return 88 - Math.min(18, pathname.split("/").length * 2);
  if (["/pricing", "/customers", "/security"].includes(pathname)) return 80;
  if (LOW_SIGNAL.test(pathname)) return -50;
  if (CORE_SEGMENT.test(pathname)) return 80 - Math.min(30, pathname.split("/").length * 3);
  return 10 - Math.min(20, pathname.split("/").length);
}

async function safeFetch(url: string, domain: string, timeoutMs: number, outerSignal: AbortSignal): Promise<Response> {
  let current = new URL(url);
  if (!isAllowedHost(current, domain)) throw new Error(`Blocked origin: ${current.origin}`);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(timeoutMs)]);
    const response = await fetch(current, { signal, redirect: "manual", headers: { "user-agent": "ManiculePromptgen/2.0" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect without location");
    current = new URL(location, current);
    if (!isAllowedHost(current, domain)) throw new Error(`Blocked redirect: ${current.origin}`);
  }
  throw new Error("Too many redirects");
}

function isAllowedHost(url: URL, domain: string): boolean {
  const base = domain.toLowerCase().replace(/^www\./, "");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return url.protocol === "https:" && host === base;
}

function htmlToText(html: string): string {
  return normalizeText(decodeHtmlEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, " ")
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, " ")
    .replace(/<[^>]+>/g, " ")));
}

function extractTitle(html: string): string {
  return normalizeText(decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""));
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&nbsp;", " ").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&#x27;", "'").replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (entity: string, code: string) => decodeCodePoint(entity, Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (entity: string, code: string) => decodeCodePoint(entity, Number.parseInt(code, 16)));
}

function decodeCodePoint(entity: string, code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
}
