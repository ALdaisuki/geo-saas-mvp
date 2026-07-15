# MCP V1 Shared Template Integration

Date: 2026-07-15

## Goal

Turn the customer-facing GEO article catalog into a versioned V1 backend capability. The same
catalog must be readable through the browser API and MCP, and a draft proposal must retain the
exact selected template. This vertical slice covers a non-excluded V1 capability; it does not
add domestic visibility evaluation, external platform publishing, image production, or the
future brand-memory feedback loop.

## Current Gap

The web application owns the only complete catalog. The MCP draft tool accepts a free-form
brief and infers one of five editorial profiles, so a customer's template choice cannot reach
Pi Agent or be verified by the backend. A UI selection can therefore drift from unattended
drafting.

## Design

1. Move the complete catalog and its types into `@geo/contracts/article-templates`.
2. Give the catalog an immutable version, `geo.article-templates.v1`.
3. Add authenticated `GET /api/article-templates`; it returns the version and complete items.
4. Add read-only `geo_template_catalog` to both the Pi allowlist and public GEO MCP server.
5. Extend `geo_draft_proposal` with optional `articleTemplateId` for backward-compatible
   automation. When supplied, it must exist in the V1 catalog and its editorial profile wins
   over heuristic brief classification.
6. Persist the selected ID in the canonical source payload and carry it to platform variants.
7. In live mode the web application loads the catalog from the API and passes it into the
   composer. Demo mode uses the same package data locally and remains clearly offline.

## Security And Failure Model

- Catalog reads require `content:read` and only return versioned public editorial metadata.
- The MCP schema is strict and accepts no URL, prompt destination, provider, or arbitrary
  template object.
- Unknown template IDs fail before a content write.
- A missing or invalid catalog response is visible as an API resource error; live creation does
  not silently substitute demo data.
- The active tenant policy remains the source of fixed publishable text and evidence bindings.
  A valid catalog ID does not bypass policy compilation, fact relevance, audit, or tenant scope.

## Acceptance Criteria

- API and MCP return the same catalog version and at least 20 complete templates.
- MCP publishes `geo_template_catalog` as read-only and includes template selection in the
  bounded draft schema.
- A selected template deterministically controls `editorialProfile` and `articleTemplateId` in
  the stored payload.
- Live web content uses the API catalog and exposes endpoint failures; demo mode remains usable.
- Contract, Agent, MCP, API, Web, type, build, and browser tests pass for the new chain.
