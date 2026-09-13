---
name: Market
description: A useful shop, not a sales landing page: tactile product shelves, clear comparisons and a visible basket.
modes: [design]
ds4_category: commerce
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/market
---
# Market — original DStudio system, version 1

## Visual thesis

Products, differences and totals take precedence over persuasion. A compact editorial masthead leads into a working catalog, with filters on the left and a basket available throughout.

Best fit: Catalogs, product comparison, configurators and local order prototypes.

## Load before building

Read `tokens.css`, `components.html`, `assets/preview.js` and
`references/recipes.md` through `pack_file(type="design_system", name="market", path="…")`.
These are original local assets, not a framework or external service.

## Compose, do not clone

Use a narrow filter rail, a two- or three-column product shelf and an explicit comparison strip. Keep price, variant and availability beside the action. On mobile, filters precede the shelf, products form one column, and the basket remains a labelled button.

A configurator can replace the shelf with a large product study and staged choices; keep a running itemized total. A comparison brief needs aligned attributes, not duplicated marketing cards.

Derive the actual content order and controls from the brief. Do not copy the
fictional preview identity into the output. Two different briefs need different
compositions, not just new words or colors. Explicit user choices take precedence.

## Tokens and typography

The executable `tokens.css` defines coordinated light/dark roles for background,
surfaces, foreground, muted text, borders, accent and status. Display uses
Georgia, "Times New Roman", serif; body uses "Helvetica Neue", Arial, sans-serif. These are local fallback stacks,
not bundled brand fonts. Preserve readable contrast, focus indicators and labels.

## Interaction and ownership

The example filters four fictional products, selects variants, compares up to three products and maintains a bounded local basket. Basket quantities are limited to six per variant; all prices are illustrative EUR amounts. No checkout, inventory reservation or payment occurs.

State is owned by the preview document and lost on reload. The agent must implement
actual persistence or external actions separately when requested; a preview
confirmation never proves a purchase, publication, file save or backend operation.
Keep limits and error states explicit. User text enters text nodes, not HTML.

## Acceptance and export

Render at 320/390/768/1440 px in light and dark. Test 200% text, keyboard navigation,
form validation, choices, empty state, dialog Escape/focus return and all domain
controls. Radio/checkbox labels keep a separate indicator column when wrapping.
Do not hide overflowing page content. Map/artboard viewports may scroll locally
when clearly labelled, with a fully keyboard-operable alternative.

Copy the needed CSS and JS beside the generated HTML and update relative links.
Export must work without DStudio, remote fonts, CDNs or APIs. Omit the catalog lab
bar from client work. Fixed preview fixtures and successful static tests do not
constitute model-generated quality evidence.
