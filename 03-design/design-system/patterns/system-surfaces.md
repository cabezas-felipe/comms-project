# System surfaces

**Foundations:** [color](../foundations/color.md) · [typography](../foundations/typography.md) · [viewports](../foundations/viewports.md)
**Related:** [button](../components/button.md) · [alert](../components/alert.md)
**Principles:** [dp1 — Calm by default](../../principles.md)

> Working pattern (v1.2.59). Pre-product and fatal recoveries — not monitoring feed errors.

## Splash

| Rule | Detail |
| --- | --- |
| When | Native app launch / cold start before first paint of product shell |
| Layout | Centered **Tempo** wordmark (`font-display`, `--ink-primary`) on `--surface-page` |
| Viewport | Mobile-only specimen is intentional (launch is phone-first); no required desktop pair |
| Not | Progress bar, tagline, or CTA on the splash itself |
| Specimen | [Splash](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZJN-0) |

## Generic error (fatal / unrecoverable shell)

| Rule | Detail |
| --- | --- |
| When | The product shell cannot load (auth crash, hard dependency fail) — **not** feed populate fail, metastory fail, or Save fail |
| Layout | Viewport-centered stack: headline + one Primary recovery CTA |
| Headline | `Something went wrong.` — Newsreader, sentence case, period |
| CTA | `Try again` — Primary (F) ink outline; no trailing `→` (retry, not navigation) |
| Chrome | No Tempo top bar, Account, or feed — full-bleed page surface |
| Pair | Desktop `1440 × 900` + Mobile `390 × 844` (or fit-content) |
| Not | Blame copy; secondary Cancel; illustration; Alert banner styling (this *is* the screen) |
| Specimens | [S2 · Generic error](https://app.paper.design/file/01M22V20HEDY4VAA8Y5S3FSP9T/5-0/ZTO-0) |

## Related (not this pattern)

| Situation | Pattern |
| --- | --- |
| First-run / empty-shell build fail | Populate error — [monitoring workflow](monitoring-workflow.md) |
| Soft refresh fail with feed | Stale freshness — [narrative row](../components/narrative-row.md) |
| Form / identity send fail | Inline or in-sheet error on the existing step |
