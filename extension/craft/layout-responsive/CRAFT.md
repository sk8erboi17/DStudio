---
name: Layout and responsive integrity
description: Design the container, reading order and media behavior together; verify narrow widths and enlarged text without hiding defects.
---

# CRAFT: layout and responsive integrity

## Choose a topology for the content

Decide reading/action order, side information, density and what changes on a
narrow screen before styling. The pack's composition is a starting point.
Change the parent flow when an element's size, aspect ratio or content changes;
check later rows and unrelated siblings too. Preserve intentional whitespace,
while repairing accidental slivers and stranded controls.

Use shrinkable grid/flex tracks (`minmax(0,1fr)`, `min-width:0`) and appropriate
wrapping. Do not reduce readable type, clip the page or hide overflow to mask a
wrong track. Keep DOM order meaningful; CSS `order` also affects grid placement
and cannot establish a keyboard/screen-reader reading order by itself.

## Media and text

Choose media size and crop together with the container. A portrait can sit beside
text or lead a full-width story; neither orientation mandates one universal card.
Give aspect-ratio an intentional width constraint, then test caps and flex sizing.
Use `object-fit:contain` when source details must remain visible; `cover` is an
explicit crop, unsuitable when it discards evidence or required labels.

Text containers grow with content. Prefer minimum rather than fixed heights;
consider dynamic viewport units for mobile chrome and content that exceeds it.
A dense table/map/editor may have a labelled local scroll region and keyboard
access. Ordinary page content still reflows without sideways page scrolling.

## Verify the exported result

Exercise 320/390/768/1440px, offered themes, 200% text, long titles, translated
controls and missing/large content. Check width and height, overlap, source/visual
order, meaningful crop and reachability of every action. No page overflow alone
is not proof of readable prose; inspect actual text boxes and cramped columns.
After HTML/CSS/font changes, rerender affected widths and operate the controls.
