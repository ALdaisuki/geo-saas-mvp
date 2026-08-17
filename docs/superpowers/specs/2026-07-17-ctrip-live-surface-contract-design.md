# Ctrip Live Surface Contract Discovery Design

## Decision

The first authenticated observation of the Ctrip Community picture-text editor
is sufficient to prove that the expected authoring surface exists, but it is not
sufficient to authorize a draft or submit action. The next increment improves
the read-only discovery evidence only. It does not add a browser writer, enable a
live canary, or add a configuration switch that can do so.

NapCatQQ is outside this design and is not a GEO dependency.

## Observed Evidence

The supervised read-only review ran on 2026-07-17 against the dedicated local CDP
session and returned:

```text
origin: https://we.ctrip.com
path: /publish/publishPictureText
observation: complete
session signal: none
challenge signals: none
outcome: adapter_drift
session evidence: 60327a6bd2f8a232b44649b8ef18d6bccc23e848a685944f88b3924ee9fa6790
evidence: 50d165af7f612d024886b1c436e58975248020d7ce1a511d7a0a9c117e7368e9
```

The bounded probe observed an editor and visible actions for image upload, draft
save, publish, and the supported article categories. It did not observe a visible
`input[type=file]`. This means the upload control may create a chooser lazily and
must not be inferred from the visible button alone.

The same run also observed an unrelated `you.ctrip.com` tab and emitted a bounded
account label. Even though labels are sanitized, unrelated authenticated pages
must not contribute control text to surface evidence.

## Scope

- Compile the exact discovery target
  `https://we.ctrip.com/publish/publishPictureText` into source.
- Limit control collection to that target. Login locations may still contribute
  session/challenge classification, but unrelated Ctrip pages contribute no
  control labels.
- Add a bounded allowlist of structural control attributes that can be read
  without reading article content or input values.
- Sanitize every attribute value with the existing label sanitizer.
- Emit deterministic, canonical control fingerprints suitable for comparing two
  supervised observations.
- Keep `reviewedSurfaces` empty and `liveCanaryEnabled=false`.

## Non-goals

- Clicking image upload, save draft, publish, category, or topic controls.
- Reading editor content, input values, cookies, storage, headers, request bodies,
  screenshots, page HTML, or arbitrary DOM properties.
- Discovering selectors from tenant input or accepting caller JavaScript.
- Login, QR, SMS, CAPTCHA, device fingerprint, or risk-control automation.
- Creating a Ctrip draft, consuming a submit permit, or claiming a publication.
- Enabling unattended browser publication.

## Evidence Contract

Each observed control retains its compiled `probeId` and sanitized semantic
label. It may additionally contain a canonical array of attributes from this
source-controlled allowlist:

```text
aria-label, aria-disabled, title, placeholder, role, type, name, id,
data-testid, contenteditable, accept, disabled
```

The reader never requests `value`, `href`, `src`, `style`, `class`, event-handler
attributes, or unrestricted `data-*` attributes. Empty, redacted-to-empty, or
unknown attributes are discarded. Attribute names and values are bounded,
deduplicated, sorted, and included in the evidence hash. The review schema moves
to `geo.ctrip-surface-review.v2`; v1 evidence already stored by the control plane
remains historical and is never reconstructed.

The manifest distinguishes:

```text
discoverySurfaces: pages whose controls may be observed
reviewedSurfaces: pages approved for a future fixed adapter
liveCanaryEnabled: whether a future writer may start
```

For this increment, only `discoverySurfaces` is populated. Discovery therefore
continues to return `adapter_drift`.

## Required Stability Evidence

Before a fixed locator can be promoted into `reviewedSurfaces`, operators must
run at least two supervised observations in separate browser sessions and review
the following invariants:

- exact HTTPS origin and path are unchanged;
- the editor and required actions have stable semantic labels or allowlisted
  structural attributes;
- no challenge signal is present;
- the upload path is understood without guessing a hidden file input;
- draft save and final publish remain distinguishable;
- no attribute selected for the adapter contains a session-specific identifier;
- a challenge or missing control fails closed as `adapter_drift`.

The evidence comparison is a design input, not an automatic approval mechanism.

## Future Canary Gates

A later, separately reviewed increment may implement a fixed adapter only after:

1. the reviewed surface and adapter version are compiled into source;
2. a draft-only canary has explicit operator authorization and a fixed audited
   payload;
3. upload, title, body, category, and draft-save actions have deterministic
   post-action readback;
4. final submit remains a separate one-time permit boundary;
5. ambiguous submit is never retried automatically;
6. an independent public Ctrip URL readback can bind the exact title, body, and
   media to the handoff.

## Acceptance Criteria

- A review of the open picture-text page emits only target-surface controls.
- Unrelated authenticated Ctrip tabs cannot leak account labels into evidence.
- Article body and input values are never read.
- Only source-compiled attributes appear, with deterministic ordering and hard
  bounds.
- Existing challenge and sensitive-label tests continue to pass.
- The real supervised command still reports `adapter_drift`.
- `assertCtripLiveCanaryReady()` still rejects.
