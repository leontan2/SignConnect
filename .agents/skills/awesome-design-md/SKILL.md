---
name: awesome-design-md
description: Use curated DESIGN.md analyses of recognizable brands to derive visual direction, design tokens, layouts, components, and responsive rules when a user requests brand-inspired UI, design-system references, or visual style comparisons. Do not use for ordinary frontend work that has no visual-reference need.
---

# Awesome Design MD

Use the local catalog in [references/design-md](references/design-md), sourced from [voltagent/awesome-design-md](https://github.com/voltagent/awesome-design-md). Each brand directory contains a `DESIGN.md` with colors, typography, spacing, components, responsive behavior, and characteristic do's and don'ts.

Treat these files as design analyses and inspiration, not official brand standards or proof of affiliation.

## Select references

- If the user names a catalog brand, read only `references/design-md/<brand>/DESIGN.md` first.
- If the desired style is described rather than named, list the catalog directories, shortlist two to four plausible references, then read only those files.
- For a comparison, extract the same dimensions from each reference: palette, type, shape, spacing, layout, imagery, motion, and component treatment.
- Read a brand's adjacent `README.md` only when its provenance or contextual notes matter.

Do not load the full catalog into context.

## Apply the direction

- Preserve the user's product requirements, content hierarchy, existing design system, and implementation stack.
- Convert the chosen reference into a coherent set of project-specific decisions. Reuse principles and relationships; do not blindly copy every token.
- Separate reusable visual traits from protected identifiers. Do not copy logos, trademarks, proprietary assets, or imply endorsement unless the user supplied and authorized them.
- Use available font fallbacks when a referenced proprietary typeface is unavailable.
- Keep accessibility, responsive behavior, interaction states, and project constraints authoritative. Adjust reference values when necessary for contrast, legibility, touch targets, or consistency.
- When blending references, assign each one a clear role, such as one for typography and another for layout, and resolve conflicts into one system.

## Inspect and verify with Playwright CLI

Use the installed `playwright-cli` skill when the task involves an existing site, a runnable local UI, implementation changes, or explicit visual verification. Read its `SKILL.md` before issuing browser commands. Skip browser automation for purely conceptual design-direction work.

- Use an isolated named session such as `playwright-cli -s=awesome-design-md ...` to avoid interfering with other browser work.
- Inspect structure with snapshots and targeted evaluation. Use screenshots when visual evidence materially helps assess hierarchy, spacing, typography, color, or responsive behavior.
- Compare relevant desktop and mobile viewports with `resize` or device emulation. Exercise important interactive states such as navigation, hover, focus, validation, and overlays when they are in scope.
- Check console messages after implementation changes when they could reveal broken UI behavior.
- Use `playwright-cli show --annotate` when the user requests interactive design feedback or wants to mark up the live page.
- Do not use persistent profiles, stored credentials, or authenticated sessions unless the user requests and authorizes them.
- Close the named session when verification is complete. Treat generated screenshots, snapshots, traces, and videos as temporary evidence unless the user asks to keep them.

When presenting or implementing the result, briefly name the references used and the significant adaptations made for the project.
