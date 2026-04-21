# Principles (v0)

## Product tone

- **Calm by default:** The interface should feel steady during long monitoring and drafting blocks; urgency is **signaled**, not ambient noise.
- **Signal over volume:** Prefer clear hierarchy and filtering language over dense decoration.
- **Respect cognitive load:** Reduce self-interruption from the UI itself (few competing focal points, predictable placement).

## UX principles

1. **Monitoring and drafting are first-class:** Layout and color semantics should support “what changed?” and “what do I do next?” without hunting.
2. **Modes matter:** Distinguish **calm** vs **fast-public** (or equivalent) with consistent visual and labeling patterns — see [monitoring workflow](patterns/monitoring-workflow.md).
3. **Status must be unambiguous:** `success`, `warning`, and `critical` have distinct meanings; do not overload accent color for danger.
4. **Readable at a glance:** Type scale and contrast tuned for scanning lists, timestamps, and outlet names.
5. **Accessible basics:** Visible focus, sufficient contrast for body text, no information conveyed by color alone.

## Anti-goals (v0)

- **Not** a full marketing brand site or illustration-heavy system.
- **Not** a complete component library in React/Vue/etc. — specs + tokens only.
- **Not** multi-brand theming until a second stakeholder needs it.

## Decision hygiene

- If a new visual need appears, prefer **new token** or **pattern doc** over one-off hex in prototypes.
- When research updates priorities, revise [patterns/monitoring-workflow.md](patterns/monitoring-workflow.md) first, then components, then tokens.