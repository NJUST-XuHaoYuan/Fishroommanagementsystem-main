# Design

## Visual Theme

The public catalog should feel like a restrained premium retail product room: Apple Store clarity, fashion buyer-room whitespace, product photography first, and almost no decorative color. The interface should look expensive because it is quiet, precise, and easy to scan.

Physical scene: a reef hobbyist opens the catalog on a phone in the evening after messaging the shop, comparing available animals calmly before asking staff to reserve one.

## Color

Use OKLCH colors for new CSS. Keep the strategy restrained: monochrome graphite, warm-neutral-free off-white, silver dividers, and one quiet ocean accent only for current selection and biological state.

- Page background: Apple-like neutral off-white, not green, blue, beige, or cream.
- Primary text: graphite, never pure black.
- Muted text: calibrated gray with enough contrast.
- Surfaces: clean white-toned panels with thin silver dividers, no glass effects.
- Accent: one refined ocean green for selected state and record markers.
- Commercial action: graphite primary buttons; coral only for price and urgent biological state.
- Warning color: amber for sold or limited status.
- Error color: soft red for sick/loss states.

## Typography

Use the existing system font stack. Reserve larger display type for the first viewport only. Product names, species names, filters, tabs, and timeline rows use compact, highly legible UI typography with deliberate weights and line heights.

Chinese copy should remain concise. Avoid hero eyebrow labels and decorative filler text.

## Layout

The first screen should immediately show the public catalog purpose, current selection path, and a strong product image. Use a three-zone product UI:

1. Category rail: compact management categories with counts.
2. Discovery: species chips/cards, search, and product results with images.
3. Evidence: selected product detail, available individual animals, and maintenance timeline.

Cards are allowed for real repeated product objects and stock items, but avoid the generic dashboard-card feeling. Use fewer borders, cleaner spacing, sticky detail panes on desktop, and a single-column flow on mobile.

## Components

- Search input with icon and clear state.
- Species filters with selected state.
- Product result cards with image, species, size, origin, price, available count, and condition summary.
- Detail panel with product hero image, scientific/common names, individual stock selector, and maintenance timeline.
- Status chips for healthy, feeding, sick, sold, and unavailable states.
- Timeline rows with date, source, operator when safe, text, media count, and tank snapshot only when appropriate for buyers.
- Skeleton and empty states that explain whether no matching species, no in-tank stock, or no maintenance records exist.

## Motion

Use 150-220 ms ease-out transitions for selection, hover, and detail changes. Respect reduced motion. Avoid decorative page-load choreography.

## Responsive Behavior

Desktop: search and results on the left or main area, selected product detail as a sticky side panel.

Mobile: search first, horizontal species chips, product list, then selected product detail. Ensure no text overlaps images or controls, and all touch targets are at least 40px high.

## Content Rules

Visible public copy should be buyer-facing and factual. Do not expose procurement batch costs, customer names, order numbers, internal user accounts, permissions, or private staff notes. If a field may be sensitive, omit it by default.
