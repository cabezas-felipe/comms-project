# Scope gates

**Foundations:** [typography](../foundations/typography.md) · [color](../foundations/color.md)
**Related:** [form intro](form-intro.md) · [button](../components/button.md) · [account menu](account-menu.md)
**Principles:** [dp1 — Calm by default](../../principles.md) · [dp6 — Surface confidence](../../principles.md)

> Working pattern (v1.2.59). Shared voice for Account **Tags** / **Context** (and onboarding Review thin) when scope is incomplete or thin.

## Formulas

### Hard gate (Save blocked)

`Add {what's missing} so Tempo can show stories.`

| Surface | Copy |
| --- | --- |
| Tags · no Press / Platforms | `Add Press or Platforms so Tempo can show stories.` |
| Tags · no Topics / Keywords / Geographies | `Add Topics, Keywords, or Geographies so Tempo can show stories.` |
| Context · empty sources | `Add sources so Tempo can show stories.` |
| Context · sources only (other fields empty) | `Add your role and priorities so Tempo can show stories.` |

Placement: muted support line under the Tags / Context tabs (same slot as Tags gates). Inter `text-sm` desktop / ~13px mobile · `--ink-muted`.

Save / Start stays **clean incomplete** (Secondary mute) — [button readiness](../components/button.md#readiness-forms-and-modals).

### Soft counsel (Save / Start allowed)

`A thinner scope means fewer stories. Add more below, or {forward verb} what you have.`

| Surface | Forward verb | Full string |
| --- | --- | --- |
| Account Tags / Context thin | **save** | `A thinner scope means fewer stories. Add more below, or save what you have.` |
| Onboarding Review thin | **start** | `A thinner scope means fewer stories. Add more below, or start with what you have.` |

Forward verb mirrors the Primary CTA (`Save →` / `Start monitoring →`). Do not mix verbs across those surfaces.

Primary stays earned (ink outline) — operator may proceed.

## Not

- Different metaphors per tab (“coverage will be thin” vs “fewer stories”)
- Warning / destructive ink for thin counsel
- Hiding the gate and relying only on disabled Save
- Survey `e.g.` labels — Context empty fields use **Example** samples under the field ([form intro](form-intro.md) / AI-context samples)

## Specimens

- Tags · No sources · No T/K/G · Thin — Account states grid
- Context · No sources · Sources only · Thin gaps — same board (gate lines aligned to Tags)
