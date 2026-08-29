---
name: SignConnect Product Design System
version: 1.1.0
status: active
source_of_truth: frontend/styles/system.css
---

# SignConnect Product Design System

Read this file before designing or changing any SignConnect interface. Existing product requirements, accessibility, privacy disclosures, and recognition behavior remain authoritative.

## Product character

SignConnect is a private, browser-first sign-recognition workspace for enterprise meetings. It should feel calm, exact, trustworthy, and operational. The interface is an application workspace, not a marketing landing page.

The system combines:

- SignConnect's warm cream, forest, coral, and sage identity.
- Uiverse Voltline-inspired signal actions: bright primary, outlined secondary, and dark ink controls.
- Linear-inspired product density, compact controls, and restrained elevation.

These are visual references only. Do not copy their logos, protected assets, or exact brand palettes.

## Design principles

1. Put the active task first. Camera, transcript, recognition status, and controls outrank decoration.
2. Make system state obvious. Connected, loading, tracking, degraded, and unavailable states must be legible without relying on color alone.
3. Protect user trust. Show the browser-local video boundary once in the persistent application header, then keep detailed consent text available to assistive technology at the recognition control.
4. Prefer one primary action per control group. Secondary actions should never compete with it.
5. Use surface changes and hairline borders for hierarchy. Reserve shadows for interactive lift and important floating surfaces.
6. Keep the desktop workspace dense but breathable. Use the 4px grid and avoid excessive cards or oversized empty areas.
7. Preserve keyboard access, visible focus, reduced motion, and readable contrast in every component state.

## Foundation tokens

The implemented tokens live in `frontend/styles/system.css`. Always reuse them before introducing a new value.

### Color

| Role | Token | Value | Use |
|---|---|---:|---|
| Canvas | `--sc-canvas` | `#f3f1eb` | Application background |
| Surface | `--sc-surface` | `#faf9f5` | Panels and chrome |
| Raised surface | `--sc-surface-raised` | `#ffffff` | Controls and active content |
| Primary | `--sc-primary` | `#123b31` | Main actions and active navigation |
| Primary hover | `--sc-primary-hover` | `#1b4a3e` | Hovered primary actions |
| Primary press | `--sc-primary-press` | `#0b2b23` | Pressed primary actions |
| Accent | `--sc-accent` | `#e97055` | Recognition-active state and focus |
| Accent hover | `--sc-accent-hover` | `#d86148` | Hovered accent action |
| Signal | `--sc-signal` | `#c8ff31` | Start-recognition action only |
| Signal hover | `--sc-signal-hover` | `#b9f220` | Hovered start-recognition action |
| Ink action | `--sc-action-ink` | `#0d1714` | Session and infrastructure actions |
| Selected | `--sc-selected` | `#d7e3c7` | Enabled camera and confirmed selection |
| Ink | `--sc-ink` | `#142a24` | Default text |
| Muted ink | `--sc-ink-muted` | `#65726d` | Secondary text |
| Hairline | `--sc-line` | `#d9d8d2` | Dividers and borders |
| Strong hairline | `--sc-line-strong` | `#c8cac4` | Interactive control borders |
| Danger | `--sc-danger` | `#b84e3b` | Errors and destructive actions |

### Typography

- Product sans: `Plus Jakarta Sans`, with `system-ui` fallback.
- Operational mono: `DM Mono`, reserved for room IDs, protocol labels, counts, and technical status.
- Headings: weight 600 to 700, slightly negative tracking.
- Body: weight 400 to 500, relaxed enough for scanning.
- Buttons: 11px to 13px in the dense desktop workspace, weight 650 to 700.
- Use tabular numerals for counts, latency, timestamps, room IDs, and confidence values.

### Spacing and shape

- Base grid: 4px.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48px.
- Button height: 36px compact, 40px default, 44px prominent.
- Control radius: 9px. Panel radius: 12px to 14px. Pills only for statuses and tags.
- Icons: 14px to 18px in controls, consistent stroke weight within a group.

## Buttons

Use the shared `.sc-button` anatomy and add exactly one visual variant.

### Anatomy

```html
<button class="sc-button sc-button--primary" type="button">
  <!-- optional decorative icon with aria-hidden="true" -->
  <span>Start session</span>
</button>
```

### Variants

- `.sc-button--primary`: the one dominant action in a control group.
- `.sc-button--signal`: Uiverse-inspired high-salience action used only to start recognition.
- `.sc-button--ink`: Uiverse-inspired dark action used for starting a realtime session.
- `.sc-button--secondary`: neutral supporting action on light surfaces.
- `.sc-button--accent`: active recognition or consented transmission state.
- `.sc-button--selected`: enabled camera or selected toggle state.
- `.sc-button--confirmed`: completed or connected state that remains visible while disabled.
- `.sc-button--danger`: explicitly destructive action.
- `.sc-button--compact`: dense toolbars and small action groups.
- `.sc-icon-button`: icon-only navigation or toolbar action. Always include an `aria-label`.

### Interaction states

- Rest: crisp border, clear label, restrained elevation.
- Hover: increase contrast, lift by 1px, and strengthen shadow. Do not change geometry.
- Pressed: return to the surface with `scale(0.98)`.
- Focus: 3px coral focus ring with clear offset.
- Loading: keep the original width, show a spinner, and use an ellipsis in the label.
- Disabled: remove lift and reduce contrast while keeping text readable.
- Confirmed: use the sage surface with forest ink; do not fade it like a generic disabled action.

### SignConnect action mapping

- Start session: dark ink button. This establishes the realtime infrastructure without competing with recognition.
- Turn camera on or off: outlined secondary, changing to the selected sage state while enabled.
- Start recognition: bright signal button. This is the primary task action and the only use of signal lime in the workspace.
- Stop recognition: coral accent button to communicate an active consented capture state.

Buttons must use active, specific labels such as “Start session,” “Turn camera on,” and “Stop recognition.” Icon-only controls need an accessible name. Never use clickable `div` or `span` elements.

## Application patterns

### Navigation rail

- Keep it visually quiet. Only the active destination receives a filled forest surface.
- Disabled future destinations remain discoverable but clearly unavailable.
- Use `.sc-icon-button` for every rail action.

### Recognition console

- Camera is the dominant working surface.
- Keep controls in a stable dock below the video so state changes do not move the capture area.
- Use the primary action for starting recognition and the accent action while recognition is active.
- Use the selected variant while the camera is enabled.

### Transcript and system health

- Confirmed captions belong in the transcript. Temporary tracking feedback stays near the camera.
- Keep status rows compact and use text plus status indicators.
- Display honest model capability and mock-model disclosures without visual alarmism.

### Empty, loading, and failure states

- Empty states explain what will appear and how to begin.
- Loading labels end with `…` and controls retain their width.
- Error messages name the problem and the next action.
- Never hide service degradation or simulate successful SGSL recognition.

### Toast notifications

- Use toasts only for discrete outcomes: session connection, connection recovery, camera readiness or failure, and recognition start or stop.
- Do not toast continuous tracking quality, hand detection, captions, privacy copy, or status already requiring persistent attention.
- Keep no more than three visible toasts, deduplicate by event category, auto-dismiss after about four seconds, and provide a dismiss button.
- Success uses sage and forest, informational notices use neutral gray, and errors use the semantic danger color.
- Toasts supplement persistent error and system-health UI; they never replace it.

## Motion

- Product easing: `cubic-bezier(0.16, 1, 0.3, 1)`.
- Interaction duration: 140ms to 180ms.
- Page or panel entrance: no more than 380ms.
- Animate only `transform` and `opacity` where possible.
- Honor `prefers-reduced-motion` and remove nonessential motion.

### Uiverse-inspired interaction layer

Use these patterns as a restrained product-motion vocabulary. They are SignConnect adaptations inspired by the open-source [Uiverse element library](https://uiverse.io/buttons), not copied visual themes.

- Signal sheen: a single diagonal highlight crosses the start-recognition button on hover. This identifies the primary task action without adding a permanent glow.
- Ink response: the start-session button uses a contained radial highlight to acknowledge pointer intent while preserving its dark infrastructure role.
- Icon and label choreography: icons and labels separate by no more than 2px on hover, then the whole control compresses on press.
- Recognition scan: a lime scan pass appears only while recognition is active. It communicates ongoing processing and must never imply a successful prediction.
- Caption reveal: new confirmed transcript entries settle upward once so incoming output is easy to locate.
- Toast lifetime: a 2px edge timer shows how long a transient notification remains visible.

Do not run more than one perpetual animation in the camera workspace. The recognition scan is the only allowed continuous decorative motion there. Disable sheen, scan, caption reveal, icon settle, and toast timing under `prefers-reduced-motion`.

## Accessibility requirements

- Maintain visible `:focus-visible` treatment on every interactive element.
- Do not communicate state through color alone.
- Decorative icons use `aria-hidden="true"`.
- Status changes use a single appropriate live region to avoid duplicate announcements.
- Preserve semantic buttons for actions and links for navigation.
- Keep contrast at WCAG AA or better.
- Camera and gesture functionality must retain keyboard-operable alternatives for all non-gesture actions.

## Do

- Reuse tokens and shared component classes from `frontend/styles/system.css`.
- Prefer compact labels, clear hierarchy, and operational feedback.
- Use one strong accent per control group.
- Validate important UI changes in the running desktop app.
- Update this file and `system.css` together when adding a reusable pattern.

## Do not

- Do not introduce a second visual language for a new screen.
- Do not use random one-off colors, radii, shadows, or spacing values.
- Do not turn the workspace into a landing page with hero copy or decorative feature sections.
- Do not use gradients, glass effects, oversized pills, or excessive glow.
- Do not restyle an existing component locally when the change belongs in the shared system.

## Implementation workflow

1. Read this file before UI work.
2. Inspect `frontend/styles/system.css` and reuse an existing token or component.
3. Refactor the requested interface to the system rather than layering unrelated styles over it.
4. Add any genuinely reusable variant to both this guide and `system.css`.
5. Run TypeScript checks, the relevant focused tests, and a desktop Playwright review.

Reference workflow and button treatment adapted from [Uiverse Design's design-system integration guide](https://uiverse.io/design/how-to-use-design-systems) and its Voltline Analytics example.
