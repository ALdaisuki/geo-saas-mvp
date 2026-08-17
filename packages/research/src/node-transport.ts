import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

import {
  ResearchCollectionError,
  type ResearchHttpRequest,
  type ResearchHttpResponse,
  type ResearchTransport,
} from "./types.js";

const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "etag",
  "last-modified",
  "location",
]);

export class NodeHttpsResearchTransport implements ResearchTransport {
  get(input: ResearchHttpRequest): Promise<ResearchHttpResponse> {
    return new Promise<ResearchHttpResponse>((resolvePromise, rejectPromise) => {
      const address = input.resolvedAddresses[0];
      if (address === undefined) {
        rejectPromise(
          new ResearchCollectionError("RESEARCH_DNS_FAILED", "Research host has no address"),
        );
        return;
      }
      let settled = false;
      const rejectOnce = (error: ResearchCollectionError): void => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      };
      const request = httpsRequest(
        input.url,
        {
          method: "GET",
          headers: {
            accept: "text/html,application/xhtml+xml,application/xml,text/xml,text/plain;q=0.8",
            "accept-encoding": "identity",
            "user-agent": input.userAgent,
          },
          lookup: (_hostname, _options, callback) => {
            const family = isIP(address);
            if (family !== 4 && family !== 6) {
              callback(new Error("Pinned research address is invalid"), address, 0);
              return;
            }
            callback(null, address, family);
          },
        },
        (response) => {
          const declaredLength = Number(response.headers["content-length"] ?? 0);
          if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
            response.destroy();
            rejectOnce(
              new ResearchCollectionError(
                "RESEARCH_RESPONSE_TOO_LARGE",
                "Research response exceeds the configured limit",
              ),
            );
            return;
          }
          const chunks: Uint8Array[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > input.maxBytes) {
              response.destroy();
              rejectOnce(
                new ResearchCollectionError(
                  "RESEARCH_RESPONSE_TOO_LARGE",
                  "Research response exceeds the configured limit",
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (settled) return;
            settled = true;
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (!RESPONSE_HEADERS.has(name) || value === undefined) continue;
              headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
            }
            resolvePromise({
              status: response.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks),
            });
          });
          response.on("error", () => {
            rejectOnce(
              new ResearchCollectionError(
                "RESEARCH_TRANSPORT_FAILED",
                "Research response stream failed",
              ),
            );
          });
        },
      );
      request.setTimeout(input.timeoutMs, () => {
        request.destroy();
        rejectOnce(new ResearchCollectionError("RESEARCH_TIMEOUT", "Research request timed out"));
      });
      request.on("error", (error) => {
        if (settled) return;
        rejectOnce(
          error instanceof ResearchCollectionError
            ? error
            : new ResearchCollectionError("RESEARCH_TRANSPORT_FAILED", "Research request failed"),
        );
      });
      request.end();
    });
  }
}
