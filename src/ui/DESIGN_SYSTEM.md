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

| Need                                           | Shared implementation                                           |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Route title, description, primary actions      | `PageHeader`                                                    |
| Search with icon and clear action              | `SearchField`                                                   |
| Choice, searchable options, keyboard selection | `Combobox`                                                      |
| Labeled form input and helper/error text       | `Field`                                                         |
| Settings label/help/control alignment          | `SettingRow`                                                    |
| Focused creation/edit task                     | `Modal`, `FormFooter`, `useTask`, `TaskError`                   |
| Destructive confirmation                       | `ConfirmAction`, same dialog structure; initial focus on Cancel |
| Empty or filtered-out resources                | `EmptyState`, compact variant inside panels                     |
| Neutral/success/warning/error labels           | `StatusBadge`                                                   |
| Optional diagnostic/details content            | `Disclosure`                                                    |
| Per-resource secondary actions                 | `ActionMenu`                                                    |

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

## Interaction states

Use `Button` for actions. Native `disabled` means unavailable; `pending` blocks activation and announces busy while retaining keyboard focus. Synchronous guards in `useTask`/`run` remain the write boundary. Modal footers are outside the disabled fieldset and retain their native form association.

Hover, held press, selection and keyboard focus are independent. Activation occurs on release; moving outside cancels. Disabled/pending controls have no hover/pressed treatment. Composite input outlines belong to the container only while its input has visible focus; clear/reveal actions own their own outline. Clear restores input focus. Switches have a 36 by 24 CSS pixel target.

Combobox search keeps Home/End, modifier keys and IME editing; arrows move the active option, selection retains a checkmark and background, Escape restores the trigger. Action menus and dialogs restore persistent triggers. Button titles use hoverable, keyboard-accessible tooltips dismissed by Escape, scroll or resize. Reduced motion and forced colors are supported.

`tests/ui-interactions.integration.mjs` verifies the interaction contract using hidden renderer fixtures, separate from real network acceptance.

## Task-first surfaces

Keep page copy short. Use `InfoTip` only for consequential limitations or ambiguous behavior, never on every label. Overview has one current-outlet hero and a focused switch/apply dialog. Saved changes remain distinct from the running outlet; measurements are invalidated when that connection changes. Resource views use underline tabs, compact filters and opt-in bulk selection. Rule priority remains its true configuration position when filtered; secondary actions live in one row menu. Details and route previews open on demand. Connection details use a bounded modal drawer with focus and table-scroll restoration.

`tests/product-ux.integration.mjs` covers saved versus applied state, node filters, rule priority/undo, route preview, cross-page drafts, command search and contextual help. Its separate 200-flow presentation fixture verifies drawer scrolling and focus; real forwarding is checked independently.

## Quiet state hierarchy

Ordinary secondary actions use a soft surface and transparent border; input boundaries retain their contrast. Dialogs, menus, tooltips and noninteractive containers use the structural border token, never the input border token. Mode selection uses a background and the native radio indicator without a second inset border. Active combobox options use a background and a local inset marker; selection retains its checkmark.

Visible focus is integrated into the existing edge with a negative outline offset. Filled primary/destructive actions use a contrasting inner focus color, switches adapt to their checked fill, and invalid fields keep error-colored focus and explanatory text. Composite editors show focus only for their input; separate clear/reveal buttons own their focus. No layout or target size changes on focus. Forced colors retain explicit selection/focus indicators; reduced motion remains supported. This contract targets clear keyboard operation; it is not a claim of a complete WCAG conformance audit.

## Alignment contract

Choice popovers match both edges of their trigger. Action menus align to the trigger's trailing edge. Placement measures the actual content height, chooses the available side, and constrains that side before positioning; a 6 px gap must remain without overlapping the trigger. Choice menus use a flex scroll region, not a fixed guessed subtraction for their search header.

Menu outer padding is 6 px; search leading icons, group labels and option labels share an 8 px inner inset. Search icons do not shrink and are vertically centered in a 36 px row. Resource rows use a shared 10 px inset and 32 px icon column. Source errors cannot vertically recenter the leading icon or actions. Stacked metric rows share column origins. Dashboard grids own their gaps rather than combining a gap with child margins. All settings contributions share the same 780 px maximum width. Switches reset native margins. Banners use the page gutter at every breakpoint.

`tests/ui-spacing.integration.mjs` adds numeric alignment checks across all eight pages, both themes, seven actual CSS viewports, choice and action popovers, and task dialogs. A page fitting its viewport does not by itself establish correct spacing.
