export interface ResearchPolicy {
  readonly allowedHosts: readonly string[];
  readonly userAgent: string;
  readonly maxBytes: number;
  readonly robotsMaxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly maxDiscoveredUrls: number;
  readonly respectRobots: boolean;
}

export interface ResearchHttpRequest {
  readonly url: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly resolvedAddresses: readonly string[];
}

export interface ResearchHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ResearchTransport {
  get(request: ResearchHttpRequest): Promise<ResearchHttpResponse>;
}

export interface ResearchRobotsEvidence {
  readonly url: string;
  readonly status: number;
  readonly contentHash: string;
  readonly rawText: string;
  readonly allowed: boolean;
  readonly sitemapUrls: readonly string[];
}

export interface ResearchPageSnapshot {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly status: number;
  readonly fetchedAt: string;
  readonly contentType: string;
  readonly contentHash: string;
  readonly title: string | null;
  readonly language: string | null;
  readonly canonicalUrl: string | null;
  readonly metaRobots: readonly string[];
  readonly indexability: {
    readonly robotsAllowed: boolean;
    readonly noindex: boolean;
    readonly nofollow: boolean;
  };
  readonly rawHtml: string;
  readonly visibleText: string;
  readonly structuredData: readonly unknown[];
  readonly discoveredUrls: readonly string[];
  readonly responseMetadata: Readonly<Record<string, string>>;
  readonly robots: ResearchRobotsEvidence;
}

export type ResearchErrorCode =
  | "RESEARCH_POLICY_INVALID"
  | "RESEARCH_URL_INVALID"
  | "RESEARCH_URL_TOO_LONG"
  | "RESEARCH_HTTPS_REQUIRED"
  | "RESEARCH_URL_CREDENTIALS_FORBIDDEN"
  | "RESEARCH_PORT_FORBIDDEN"
  | "RESEARCH_IP_HOST_FORBIDDEN"
  | "RESEARCH_HOST_NOT_ALLOWED"
  | "RESEARCH_DNS_FAILED"
  | "RESEARCH_ADDRESS_FORBIDDEN"
  | "RESEARCH_TRANSPORT_FAILED"
  | "RESEARCH_TIMEOUT"
  | "RESEARCH_RESPONSE_TOO_LARGE"
  | "RESEARCH_REDIRECT_INVALID"
  | "RESEARCH_REDIRECT_LIMIT"
  | "RESEARCH_HTTP_STATUS_INVALID"
  | "RESEARCH_ROBOTS_FETCH_FAILED"
  | "RESEARCH_ROBOTS_DISALLOWED"
  | "RESEARCH_CONTENT_TYPE_UNSUPPORTED"
  | "RESEARCH_SITEMAP_INVALID";

export class ResearchCollectionError extends Error {
  readonly code: ResearchErrorCode;

  constructor(code: ResearchErrorCode, message: string) {
    super(message);
    this.name = "ResearchCollectionError";
    this.code = code;
  }
}
