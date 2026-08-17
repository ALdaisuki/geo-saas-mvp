# GEO Domain Vocabulary

## Channel Account

An identity owned by a tenant on an external publishing platform. A channel
account is the unit of authorization, health, quota, audit, and publication
history. It is not a browser credential and it is never interchangeable with
another account.

## Ctrip Runtime Binding

The account-scoped binding between a Ctrip channel account and a protected
browser runtime. It owns the opaque profile reference, bridge authority, and
session readiness. It never exposes or stores passwords, cookies, local
storage, or raw tokens in the GEO API.

## Account Pool

The ordered set of tenant-owned channel accounts resolved by the server for a
selected platform. Only accounts that are active, capable of the requested
execution level, allowed by account controls, within quota, and runtime-ready
when required may receive new assignments.

## Distribution

The deterministic assignment of each content slot to one account in an
account pool. The primary policy is `platform_round_robin`: the caller chooses
the platform and the server resolves the eligible account pool under a
tenant-scoped persistent cursor. Legacy `round_robin` account-pool requests
remain supported for compatibility.

## Fan-out

The explicit operation in which one slot has multiple account targets. Fan-out
is distinct from distribution and is not the default for generated batches.

## Slot Assignment

The persisted `slot -> channel account` decision used to create the account-
bound variant, audit, grant, and publication job. An operator may change the
assignment only while the run is scheduled, unclaimed, at attempt zero, and
has no content or target resources. The assignment becomes immutable on the
first claim. A post-submit uncertain result can only be read back on the
assigned account; it cannot be silently reassigned.

## Promotion Campaign

A tenant-owned, continuously running commercial objective for one brand. It
defines the audience, region, keywords, destination, platform mix, daily
volume, soft-promotion strategy, and operating limits. One campaign never
mixes facts or identity from another brand.

## Trend Observation

A time-bound report that a source currently presents a subject as noteworthy.
It records the source, source-native rank or heat, first and latest observation
times, and the evidence needed to judge freshness. An observation is not yet a
publishable topic.

## Trend Cluster

The tenant-neutral grouping of observations that describe the same current
event or subject. Its freshness expresses whether the subject is emerging,
rising, peaking, cooling, or expired. Its heat is distinct from its relevance
to any particular campaign.

## Topic Candidate

A campaign-owned proposal produced by matching a trend cluster or evergreen
idea against the brand, audience, region, and promotion objective. Only a
candidate with sufficient relevance and usable evidence may enter production.

## Evidence Pack

The immutable set of public trend evidence and tenant-authorized brand facts
used for one content lineage. Retrieval may be supplied by an external RAG
system, but the pack is the local boundary used to validate claims and explain
why the topic was selected.

## Content Lineage

The traceable family formed by one evidence pack, one master draft, its
platform base variants, and its account-final variants. Facts may be shared
within the family, while expression and platform formatting remain distinct.

## Master Draft

The platform-neutral article authored for one topic candidate and promotion
campaign. It carries the useful-information, brand-placement, and call-to-
action proportions from the campaign's versioned promotion strategy.

## Platform Base Variant

The platform-specific interpretation of a master draft. It applies the target
platform's title, structure, length, media, tone, and call-to-action rules, but
is not yet assigned to a publishing account.

## Account-final Variant

The immutable, account-bound version derived from a platform base variant and
the assigned channel account's audience and performance profile. It is the
only object that may be audited, granted, submitted, reconciled, and publicly
read back.

## Machine Review Decision

The automatic disposition of an account-final variant: `passed`,
`rewrite_required`, or `blocked`. Rewriting creates a new immutable variant;
it never mutates the reviewed payload. A blocked result does not enter a human
review queue in the first release and is replaced by new production work.

## Public Readback Confirmation

The first independent observation that a platform-approved account-final
variant is publicly accessible and matches its expected content identity. One
confirmation completes the first-release success criterion; repeated
availability monitoring is a separate concern.

## Account Heat Score

A rolling, normalized measure of a channel account's publication success,
approval rate, per-item reach and engagement, and session health. It influences
future allocation within fixed platform and tenant limits; it never authorizes
publication or overrides an account cap.

## Unified Canary

The single coordinated release check for the first-priority platforms. One
master draft produces one account-final variant for Toutiao, Sohu, Baijiahao,
and NetEase. Successful results are retained, failed platforms are repaired
independently, and unattended operation remains closed until every platform
has one public readback confirmation.
