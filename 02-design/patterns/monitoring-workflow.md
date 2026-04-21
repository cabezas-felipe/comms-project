# Monitoring-first workflow pattern

This pattern translates research findings into UI structure for the v0 prototype.

## Research basis

- Monitoring is the top pain and priority in current evidence.
- Core burden is self-interruption while drafting.
- Work oscillates between calmer periodic checks and fast-public continuous checks.

Sources:

- [Research context](../../01-research/00-ops/research-context.md)
- [Interview synthesis (Mercedes)](../../01-research/interview-synthesis--zero-to-one--mercedes-osma.md)

## Pattern goals

1. Reduce interruption cost while preserving situational awareness.
2. Make mode state obvious (calm vs fast-public).
3. Surface what changed since last check with minimal noise.

## Recommended UI pattern

- Persistent mode indicator in top bar.
- Feed rows with explicit delta markers (`new source`, `new angle`, `same narrative`).
- Draft panel remains visible while monitoring signals update.
- Priority strip for `warning` and `critical` items only.

## Color and component mapping

- Use `accent` for informational deltas.
- Use `warning` for potential escalation.
- Use `critical` for high-likelihood miss risk requiring immediate action.
- Render statuses with [Alert](../components/alert.md) and [Badge](../components/badge.md) patterns.