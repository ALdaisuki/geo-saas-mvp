# GEO Operations Console UI Direction

## Product posture

The console is a desktop-first, high-throughput operations surface. It should
prioritize scanning, comparison, queue control, and exception handling. It is
not a marketing site and should not turn every section into a floating card.

## GitHub references

The implementation borrows interaction patterns, not source code, from these
mature operational consoles:

- [Trigger.dev](https://github.com/triggerdotdev/trigger.dev): compact page
  title/accessory rows, table variants, sticky headers, row-level hover actions,
  focus-visible states, and reusable status primitives.
- [Kestra](https://github.com/kestra-io/kestra): execution status hierarchy,
  bounded run timelines, tabular timestamps, and failure-first run detail.
- [Windmill](https://github.com/windmill-labs/windmill): workspace navigation,
  restrained controls, connection indicators, drawers, and dense list rows.
- [PostHog](https://github.com/PostHog/posthog): analytics hierarchy, compact
  filters, progressive detail, and visible empty/loading/error states.

The following upstream files were inspected on 2026-08-04:

- `triggerdotdev/trigger.dev/apps/webapp/app/components/primitives/PageHeader.tsx`
- `triggerdotdev/trigger.dev/apps/webapp/app/components/primitives/Table.tsx`
- `triggerdotdev/trigger.dev/apps/webapp/app/components/primitives/Timeline.tsx`
- `kestra-io/kestra/ui/src/components/executions/overview/components/RunTimeline.vue`

## GEO rules

1. One persistent workspace navigation and one compact route header.
2. Tables and queues use stable columns, sticky headings, tabular numbers, and
   row hover feedback. Actions stay icon based with accessible labels.
3. Status is always text plus color. Internal enum values are translated in
   user-facing views.
4. Trend discovery emphasizes freshness and heat. Publishing emphasizes state,
   account, quota, failure, and public readback. Audit emphasizes immutable
   identity and blocking findings.
5. Forms use two columns only when fields are genuinely comparable. Long facts,
   policy text, and evidence remain full width.
6. Motion is short and functional: route entry, dialog entry, row hover,
   progress updates, and button feedback. Reduced-motion preferences disable it.
7. Mobile supports monitoring and emergency controls. Dense editing and wide
   tables scroll inside their own bounded regions without shifting the page.

## Visual system

- Neutral light workspace, charcoal navigation, green primary actions.
- Blue for information, amber for waiting/risk, red for failure or destructive
  action, and green for confirmed/healthy states.
- Six-pixel working radii, one-pixel borders, limited shadows for overlays only.
- Twelve-pixel minimum operational copy and tabular numerals for metrics, time,
  quotas, hashes, and IDs.
- Component transitions use 160-200 ms easing; route entry may use 280 ms.
