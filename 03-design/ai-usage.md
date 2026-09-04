# AI usage guide

Use this file when prompting Cursor, Claude Code, v0, or other prototyping tools.

## Instruction block (copy/paste)

Use the design system in `03-design/` as the source of truth.

Required references:

1. `03-design/tokens/design-tokens.json` (canonical token values)
2. `03-design/tokens/tokens.css` (CSS variable names)
3. `03-design/foundations/*.md` (usage rules)
4. `03-design/components/*.md` (component behavior and constraints)
5. `03-design/patterns/monitoring-workflow.md` (domain pattern)

Constraints:

- Do not use `03-design/archive/` as source of truth unless explicitly requested; default to `foundations/`, `tokens/`, and `components/`.
- Use Tailwind spacing classes (`p-4`, `gap-3`, etc.) for layout; see list vs card density guidance in [foundations/spacing.md](foundations/spacing.md).
- Honor `prefers-reduced-motion` (see [tokens.css](tokens/tokens.css) and [foundations/motion-and-feedback.md](foundations/motion-and-feedback.md)); no lateral shimmer on feed skeletons.
- Do not invent new color values unless asked. Use `hsl(var(--token))` with named CSS vars from [tokens/tokens.css](tokens/tokens.css).
- Prefer semantic tokens over hard-coded styles.
- Use `--secondary` (`hsl(36 18% 88%)`) for row selection; reserve `--primary` for actions and `--ember` for priority/emphasis cues (see [foundations/color.md](foundations/color.md)).
- Keep `--signal-warning` and `--destructive` meanings distinct.
- Keep layout stable between calm and fast-public modes.
- Follow typography roles: `font-display` (Fraunces) for titles/nav; `font-sans` (Inter) for dense feed metadata, tables, and body copy; `font-mono` (JetBrains Mono) for code. Prefer `text-sm` minimum for scan metadata (see [foundations/typography.md](foundations/typography.md)).

## Prompt template

Create a prototype screen for [scenario] using the design system in `03-design/`.
Use semantic tokens only. If a needed style is missing, propose a new token with rationale.
Apply monitoring-first pattern conventions and preserve warning vs critical distinction.