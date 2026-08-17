---
project: geo-saas-mvp
date: 2026-08-03
status: accepted-for-implementation
tags: [trends, drafting, variants, review, publishing, analytics]
---

# Hotspot-to-distribution MVP

## Goal

Turn the existing governed GEO control plane into an unattended commercial
soft-promotion system:

```text
trend collection -> topic selection -> AI article -> account-final variants
  -> machine review -> multi-account asynchronous publishing -> public readback
```

The first production tenant is `sample-travel`. The first
campaign uses the supplied Yunnan travel-agency keyword set without embedding
travel-only behavior in shared modules.

## Release scope

The MVP includes:

- trend adapters for Toutiao, Baidu, Weibo, Zhihu, Sohu News, and NetEase News;
- a 15-minute discovery target, source-native heat, freshness decay, clustering,
  duplicate suppression, and campaign relevance;
- the existing immutable tenant fact snapshot and captured trend evidence;
- a configurable soft-promotion strategy whose default is 70% useful
  information, 20% natural brand placement, and 10% light call to action;
- a platform-neutral master draft, platform base variants, and immutable
  account-final variants;
- Toutiao, Sohu, Baijiahao, and NetEase account onboarding, isolated browser
  sessions, fixed publishing adapters, approval tracking, public readback, and
  native account analytics;
- automatic review outcomes `passed`, `rewrite_required`, and `blocked`;
- cross-account parallel execution, same-account serial execution, leases,
  heartbeats, idempotency, retry classification, and post-submit reconciliation;
- account heat ranking and bounded dynamic quota allocation;
- an operations account that can enter an explicit tenant context, with every
  cross-tenant action audited;
- a desktop-first operations console with SSE updates and a five-second polling
  fallback;
- one coordinated four-platform canary before unattended operation is enabled.

The MVP explicitly excludes the RAG knowledge base itself, short-video
production, CRM conversion attribution, external alert delivery, full mobile
editing, and new Zhihu or WeChat publishing adapters. Existing Ctrip behavior
must remain regression-safe.

## Success and capacity

A final target counts as successful only when the platform has approved it and
one independent public readback confirms the expected content identity. A
click, toast, redirect, preview, draft, or unverified browser observation is not
success.

The business target is 5,000 successful platform-final variants per day after
the account pool is large enough. The MVP infrastructure is tested at 10,000
target lifecycles per day and approximately 50 concurrent account slots. Live
acceptance uses the coordinated canary and a quota-bounded batch; it does not
force 5,000 writes through eight test accounts.

The trend fast lane targets P95 of 30 minutes from first observation to
publication submission. Platform approval time is measured separately.

## Content and review rules

Every result is a soft promotion. The promotion ratio and all platform content
rules are versioned variables editable by an operations account. Changes apply
only to new work.

The production review target covers:

1. illegal products;
2. fabricated qualifications;
3. absolute efficacy claims;
4. official impersonation;
5. malicious defamation;
6. privacy disclosure.

The current MVP does not use keyword lists or regular-expression matches to
classify the first five semantic categories. Those checks are deferred until a
future RAG-backed semantic reviewer is connected. The lightweight gate still
checks structured privacy identifiers, claim and evidence integrity, duplicate
content, platform limits, media evidence and publication authority. It must not
report the deferred semantic categories as verified.

Semantic duplicate checks are limited to the same tenant, brand, and platform
over 30 days. They retrieve at most the 20 nearest prior items and allow at most
two rewrites before selecting a new topic.

## Trend and evidence boundaries

A trend observation records the source value, rank, first observation, latest
observation, source update time, and content fingerprint. A cluster records
freshness independently of campaign relevance. Expired evidence cannot support
new factual claims.

The current MVP does not call a RAG or knowledge-base service. Drafting and the
lightweight gate use the immutable tenant fact snapshot plus captured trend
evidence. Missing evidence does not block generic informational copy, but it
cannot support qualifications, rankings, efficacy, price promises or other
concrete assertions. A future evidence provider and semantic reviewer may reuse
this boundary without changing the current content lineage.

## Publishing behavior

Official APIs and OAuth are preferred. Where no reviewed API exists, a customer
logs in through an account-isolated persistent browser session. Business APIs
store only opaque runtime references and session health, never raw cookies,
passwords, tokens, or caller-supplied profile paths.

Pre-submit transient failures may retry with bounded backoff. After a submit
action, an uncertain result enters reconciliation and public readback; it is
never blindly submitted again. A definitive platform rejection may create a
new account-final variant and review attempt. Before the first claim, capacity
may be reassigned and the account variant regenerated. After claim, assignment
is immutable.

The unified canary publishes one lineage across Toutiao, Sohu, Baijiahao, and
NetEase at the same coordinated release point. Successful platform results are
retained. Failed platforms are repaired and rerun independently. The tenant's
unattended gate opens only after all four platforms have one public readback
confirmation. Tenant and platform kill switches remain available.

## Account allocation and analytics

Customer or agency accounts belong permanently to one tenant and are never
shared. The default heat score uses a seven-day rolling window:

- publication success: 25%;
- platform approval: 25%;
- per-item reach and engagement: 30%;
- session health: 20%.

Weights and windows are versioned settings. Quotas adjust once per day, normally
by 10-20%, while preserving cold-start exploration and platform/account hard
caps. Platform-native observations remain visible beside the normalized score.

MVP analytics include submission, approval, public readback, impressions or
reads, likes, saves, comments, follower change, and session health. Campaign
links may carry attribution parameters, but consultation and sales attribution
are deferred.

## Operations console

The default screen is the operations console, not a landing page. It shows the
daily goal, confirmed count, seven-stage pipeline, trend radar, four-platform
health, account pool, current quotas, failures, and public readbacks. SSE drives
live updates with polling fallback. Desktop has complete operations; mobile is
limited to monitoring and emergency stop. Transitions are restrained,
consistent, and disabled when reduced motion is requested.

## Public test seams

Tests observe behavior only through these confirmed boundaries:

1. Trend API: source observations become freshness-scored clusters and topic
   candidates.
2. Production API: a candidate becomes a master draft and account-final
   variants.
3. Review API: a final variant becomes passed, rewrite-required, or blocked.
4. Publishing adapter contract: session validation, submission,
   reconciliation, approval, and public readback.
5. Operations API and SSE: start a campaign run and observe its complete state.
