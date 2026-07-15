# GEO Article Template Catalog Design

Date: 2026-07-15

## Goal

Give every tenant at least 20 customer-selectable article strategies without weakening the
closed-reference publication model. A selection must explain its business benefit, GEO
mechanism, required evidence, article outline, and prohibited boundaries before it enters the
draft workflow.

## Research Basis

The catalog adapts general methods from Crawlie (answerability, semantic structure,
crawlability, authorship and schema), Auto-GEO (answer-first sections, question headings,
FAQs, information gain and validation), and AI Visibility Audit (intent segmentation,
citation/competitor measurement and feedback). The Medium article and Hacker News
discussions are commentary only. No source wording or AGPL implementation is copied.

These sources do not prove that Doubao or Qwen follow Google Search. The product therefore
describes mechanisms as testable hypotheses and measures domestic AI products separately.
It does not promise ranking, inclusion, citation, traffic, or sales outcomes.

## Product Model

- `articleTemplateId` identifies the selected customer-facing editorial strategy in the
  versioned catalog.
- `editorialProfile` remains one of the five governed source structures: guide,
  question-answer, comparison, risk-avoidance, or local-service.
- The selected template ID is hashed into the version payload and carried into platform
  variants. This preserves attribution without overloading `topicKey`.
- The active tenant policy remains the only source of publishable fixed text. A template whose
  profile is absent from the active policy fails closed.

## Interface

The content workspace shows a dense template browser with category filters, search, a
selectable list, and one detail pane. The detail pane contains:

1. Applicable scenario and a travel-industry example.
2. Customer benefit.
3. GEO mechanism and answer structure.
4. Evidence required before drafting.
5. Risk boundaries checked before publication.

The same browser is embedded in the live article composer. Selecting a template sets both the
stored `articleTemplateId` and its governed `editorialProfile`. Demo mode permits selection and
inspection but does not claim that an API write occurred.

## Acceptance Criteria

- The catalog contains at least 20 unique IDs and all five categories.
- Every template maps to a supported governed profile.
- Every template has non-empty benefit, mechanisms, outline, evidence and risk boundaries.
- Customer-facing copy contains no guaranteed ranking or citation claim and no Google-to-
  Doubao/Qwen equivalence.
- Desktop uses a list/detail workspace; mobile stacks without horizontal overflow.
- Live creation persists the exact template ID in the canonical payload.
