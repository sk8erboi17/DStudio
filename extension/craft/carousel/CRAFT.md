---
name: Carousel and horizontal scroller
description: Use a scroller only for a real comparison/sequence need; preserve readable media, keyboard operation and explicit position.
---

# CRAFT: carousel and horizontal scroller

## Choose the right presentation

Use a horizontal sequence when order or side-by-side exploration helps the task.
If all essential content fits better as a list/grid, use that. Give cards an
intentional flex basis and bounded media region; preserve readable text when
200% enlargement makes a card taller. Portrait media need a deliberate size/crop,
not an automatic forced landscape ratio.

Let the region scroll without making the whole page wider. Scroll-snap can help,
but must not trap touch or prevent reaching long card content. A visible next
item, scrollbar or clear controls can communicate more content; do not fade
required text or make essential actions partly inaccessible.

## Controls and state

Expose a named region and keyboard-operable previous/next controls when useful.
At boundaries disable or explain the applicable action; handle zero, one and many
items explicitly. If there are dots or position labels, derive them from actual
position and permit an equivalent keyboard action. Preserve focus and selection
when items update; do not rebuild every card on each scroll event.

Give media controls, labels and metadata distinct space. Use real links/buttons
and accessible names. Avoid overlapping a centered play button with a centered
caption. Keep user text literal and images meaningful.

## Motion and verification

No automatic advance by default. If requested, provide pause, respect focus and
reduced motion, and keep user-driven navigation available. Smooth scrolling must
not be required to commit state or announce success.

Test keyboard, touch/pointer, boundaries, varying card heights, translated labels,
200% text and mobile width. Check position after resize and data removal; test the
export without DStudio or external requests. A row that scrolls is not proof that
its controls or media operations work.
