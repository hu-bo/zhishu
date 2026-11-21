import type {
  WebExtractOutcome,
  WebSearchOutcome,
  WebSearchPort,
} from "@zhishu/ai-plugins/contracts";
import { WebToolError } from "@zhishu/ai-plugins/contracts";
import type { AppConfig } from "../../config.js";

/**
 * Server-side Tavily adapter. The key comes only from server env/deploy config and is
 * attached to the Authorization header here; it never reaches capabilities, the database,
 * model context, logs or error bodies. Fixed official endpoints only.
 */
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const MAX_RESPONSE_BYTES = 2_000_000;

export function createTavilyPort(
  config: AppConfig,
  limits: { resultsPerCall: number; extractMaxBytes: number; timeoutMs: number },
): WebSearchPort | null {
  const key = config.TAVILY_API_KEY;
  if (!key) return null;
  const call = async (
    url: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new WebToolError("TIMEOUT");
    }
    if (!response.ok) {
      throw new WebToolError(
        response.status === 401 || response.status === 403
          ? "AUTH_FAILED"
          : response.status === 429
            ? "RATE_LIMITED"
            : "NETWORK",
      );
    }
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (response.body)
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new WebToolError("EXTRACT_FAILED");
        chunks.push(chunk as Uint8Array);
      }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new WebToolError("NETWORK");
    }
  };
  return {
    async search(input) {
      const data = await call(
        TAVILY_SEARCH_URL,
        {
          query: input.query,
          max_results: Math.min(input.maxResults, limits.resultsPerCall),
          search_depth: "basic",
          // The vendor answer is never evidence; only real results with URLs are.
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          include_usage: true,
          ...(input.allowedDomains?.length ? { include_domains: [...input.allowedDomains] } : {}),
          ...(input.blockedDomains?.length ? { exclude_domains: [...input.blockedDomains] } : {}),
          ...(input.timeRange ? { topic: "news", time_range: input.timeRange } : {}),
        },
        input.signal,
      );
      const results = Array.isArray(data.results) ? data.results : [];
      const candidates = results
        .map((raw) => {
          const value = raw as Record<string, unknown>;
          return {
            title: typeof value.title === "string" ? value.title : "",
            url: typeof value.url === "string" ? value.url : "",
            content: typeof value.content === "string" ? value.content : "",
            ...(typeof value.published_date === "string"
              ? { publishedAt: value.published_date }
              : {}),
            ...(typeof value.score === "number" ? { score: value.score } : {}),
          };
        })
        .filter((candidate) => candidate.url && candidate.content);
      const usage = data.usage as Record<string, unknown> | undefined;
      return {
        candidates,
        ...(typeof data.request_id === "string" ? { requestId: data.request_id } : {}),
        ...(typeof usage?.credits === "number" ? { creditsUsed: usage.credits } : {}),
      } satisfies WebSearchOutcome;
    },
    async read(input) {
      const data = await call(
        TAVILY_EXTRACT_URL,
        {
          urls: input.urls.slice(0, 5),
          extract_depth: "basic",
          format: "markdown",
          include_usage: true,
        },
        input.signal,
      );
      const results = Array.isArray(data.results) ? data.results : [];
      const failed = Array.isArray(data.failed_results) ? data.failed_results : [];
      const usage = data.usage as Record<string, unknown> | undefined;
      return {
        results: [
          ...results.map((raw) => {
            const value = raw as Record<string, unknown>;
            return {
              url: typeof value.url === "string" ? value.url : "",
              ...(typeof value.raw_content === "string" ? { extracted: value.raw_content } : {}),
            };
          }),
          ...failed.map((raw) => {
            const value = raw as Record<string, unknown>;
            return {
              url: typeof value.url === "string" ? value.url : "",
              error: typeof value.error === "string" ? value.error : "EXTRACT_FAILED",
            };
          }),
        ],
        ...(typeof data.request_id === "string" ? { requestId: data.request_id } : {}),
        ...(typeof usage?.credits === "number" ? { creditsUsed: usage.credits } : {}),
      } satisfies WebExtractOutcome;
    },
  };
}
