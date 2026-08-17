# Keyword-driven licensed image search

## Goal

Replace arbitrary multi-image selection with an auditable flow that searches for images from
article-specific keywords, verifies pixel-level relevance, and feeds the existing Ctrip 4-to-5
image audit and draft preparation pipeline.

## Scope

- Pi authors a `mediaSearchPlan` with 4 or 5 distinct intents, exactly one cover, and verified
  fact IDs for every intent.
- The first provider is Wikimedia Commons. API and download hosts are fixed in code; arbitrary
  URLs are never fetched.
- Search metadata must contain a supported commercial-use license, source page, license URL,
  creator/credit metadata, and a downloadable image rendition.
- Downloaded images are normalized to 1200 x 900 JPEG. The rights record states that an
  automated crop and resize occurred.
- Pi Vision receives the exact query, rationale, article title, and relevant section context.
  A candidate must pass article relevance, travel relevance, contact-text, safety, OCR, and
  confidence checks.
- Failed candidates are skipped. Successful candidates still pass byte uniqueness, semantic
  scene diversity, one-cover, image-count, and platform audit checks.
- The operation stops after importing the plan. It cannot issue a publication grant, submit
  permit, or browser publication command.

## Request flow

1. Pi submits an authored draft containing `mediaSearchPlan`.
2. `geo_media_search_import` requests a tenant-scoped import for that immutable content version.
3. The API searches each intent independently and downloads bounded Wikimedia renditions.
4. Images are normalized and passed to the existing media import service with immutable rights
   evidence and query relevance context.
5. The import service creates a successor content version per accepted image.
6. The operation returns the final five-image content version or fails closed with the unfilled
   intent and candidate rejection codes.

## Failure policy

- Search provider disabled or unavailable: no fallback to fixture or arbitrary web scraping.
- Unsupported or missing license metadata: reject candidate.
- Non-image, oversized response, redirect, host drift, or decode failure: reject candidate.
- Pi Vision returns a visual rejection: retain the immutable bytes and inspection evidence as
  `vision-audit:degraded`; the audit records a warning and the candidate may continue through
  variant and publication gates. Transport, timeout, or malformed-provider failures use explicit
  degraded evidence tied to the asset hash. Authentication, tenant configuration, byte integrity,
  rights, and structural validation failures still reject the candidate.
- Fewer than four accepted images: fail; no platform variant or audit may be created.
- Existing media on the requested version: reject to avoid mixing manual and automated plans.

## User experience

The content screen shows the five planned searches and one action, `按文章关键词自动配图`.
Progress is reported per intent. The operator can edit the article and regenerate the plan, but
cannot silently substitute an unrelated image after audit.

## StarDots boundary

StarDots is not a keyword-search provider. Its documented OpenAPI manages spaces and files
(list, upload, delete, and private access tickets) but exposes no image discovery, semantic
search, or license catalogue. It may later sit behind an optional image-hosting/CDN adapter for
cross-platform URL delivery or backup. It is intentionally outside the Ctrip search/import
critical path, which uploads inspected bytes directly.
