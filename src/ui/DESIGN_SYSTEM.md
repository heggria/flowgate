# FlowGate UI system

This file describes the implemented shared UI contract. It applies to every route and to contributed settings/detail panels.

## Source of truth

`style.css` owns the light/dark palette and shared visual rules. Each selector is defined once within a conditional scope. Edit its existing rule instead of appending a new override generation. Responsive rules are collected at the end. Theme variants change semantic tokens rather than introducing feature-specific colors.

- Body 13 px; page title 23 px / 650; section title 13–14 px / 600; helper text 11–12 px.
- Controls use `--control-height` (36 px) and `--radius-control` (6 px). Standard action buttons use `--button-height` (34 px); compact row actions have an explicit smaller variant.
- Panels use `--radius-panel` (8 px), dialogs `--radius-dialog` (13 px). Dialogs share header/content/footer padding and backdrop.
- Neutral colors express structure/selection. Green indicates successful/running states, amber uncertain/pending states, red errors/destructive actions. Chart upload/download colors encode different series.
- Page heading, resource toolbar, settings row and disclosure spacing come from shared classes. Feature layouts may choose columns or widths but do not redefine the underlying controls.

## Components

| Need | Shared implementation |
| --- | --- |
| Route title, description, primary actions | `PageHeader` |
| Search with icon and clear action | `SearchField` |
| Choice, searchable options, keyboard selection | `Combobox` |
| Labeled form input and helper/error text | `Field` |
| Settings label/help/control alignment | `SettingRow` |
| Focused creation/edit task | `Modal`, `FormFooter`, `useTask`, `TaskError` |
| Destructive confirmation | `ConfirmAction`, same dialog structure; initial focus on Cancel |
| Empty or filtered-out resources | `EmptyState`, compact variant inside panels |
| Neutral/success/warning/error labels | `StatusBadge` |
| Optional diagnostic/details content | `Disclosure` |
| Per-resource secondary actions | `ActionMenu` |

Use existing `.primary`, `.secondary`, `.quiet`, `.iconbutton`, `.dangerbutton` action styles. These are intentionally native buttons for normal form, disabled and keyboard behavior. Do not create feature-specific button palettes.

## Behavior

All fields/actions have accessible names. Popovers support filtering, arrows, Enter, Escape and focus restoration. Native dialogs contain keyboard focus and restore it on close. Confirmations default to Cancel. Pending operations prevent duplicate writes; errors remain near the initiating form. Closing an editor preserves its keyed draft. Search/filter empty states provide a clear action. Reduced-motion mode disables animation.

## Verification

`tests/ui-consistency.integration.mjs` covers all eight routes, both themes, two window sizes, empty states, search/filter keyboard interaction, details, confirmation cancellation and screenshots. `tests/ui-design.integration.mjs` verifies real HTTPS import, local validation, pending cancellation, draft isolation and form focus. Existing journey, extension, update and actual forwarding tests cover preserved business behavior. Evidence is isolated under `work/ui-consistency/`.

## Extensions

Optional extensions use grouped rows and switches for persisted preferences. Runtime errors are separate; pending writes prevent duplicates and retain focus. Core failures force their normally collapsed section open. Details use an explicit nonmodal inspector, replacing the list below 1150 px. Escape and Back restore focus. The inspector header stays visible while scrolling. Updates open on demand; search appears for catalogs of at least ten entries.

## Geometry and edge states

Panel padding, page gutters and sidebar width use shared variables. Table edge alignment derives from panel padding. Responsive breakpoints are ordered from wide to narrow. Long user names, DNS values, rules and release identifiers must wrap or truncate deliberately without expanding a page. Native windows have a 960 px minimum; zoom exercises 768, 640 and 480 CSS px, with a compact named navigation rail at 640 and below.

Menus use the native popover top layer with measured viewport placement; choice menus measure their actual height. Scrolling outside or resizing dismisses them. Dialogs mount into the document body, avoiding row-specific styles and event handling. Menu-origin dialogs restore focus to the persistent menu trigger. Error text and destructive actions retain semantic colors; opacity must not make functional labels fail contrast.

`tests/ui-layout.integration.mjs` checks 96 real-Service route/theme/actual-viewport cases, long resources, table bounds, axe contrast/accessibility, popup edge placement, keyboard selection, portal placement and focus restoration. `tests/ui-states.integration.mjs` checks loading, pending, failure, cancellation, withdrawn updates and synthetic traffic in explicitly marked presentation fixtures. These fixtures verify UI states only; they are not connectivity evidence. Both tests run hidden and non-focusable and are included in `npm run verify`.
