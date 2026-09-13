# Market: application recipes

## Primary composition

Use a narrow filter rail, a two- or three-column product shelf and an explicit comparison strip. Keep price, variant and availability beside the action. On mobile, filters precede the shelf, products form one column, and the basket remains a labelled button.

## A genuinely different second brief

A configurator can replace the shelf with a large product study and staged choices; keep a running itemized total. A comparison brief needs aligned attributes, not duplicated marketing cards.

## Domain behavior

The example filters four fictional products, selects variants, compares up to three products and maintains a bounded local basket. Basket quantities are limited to six per variant; all prices are illustrative EUR amounts. No checkout, inventory reservation or payment occurs.

Use the smallest local state needed for the task. Keep state ownership explicit,
validate edits before applying them and bound history and user input. Do not keep
an unrelated subsystem alive just to support a preview action.

## Responsive and accessible

Use shrinkable grid children, visible labels, logical reading order and native
controls. At narrow widths stack domain regions rather than compressing paragraphs
into slivers. At 200% text let controls grow; do not clip their names. Restore focus
when a dialog closes or a selected item is removed. Respect reduced motion.

## States and delivery

Empty views offer an implemented way back. Errors preserve valid input and explain
what failed. Confirmation names only the effect that actually happened. Copy local
dependencies into the exported project, removing catalog-only controls and fictional
identities. Exercise generated output in a browser; do not manually repair benchmark
HTML and call it a model delivery.
