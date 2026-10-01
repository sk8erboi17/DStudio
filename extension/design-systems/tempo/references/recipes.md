# Tempo: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Choose a topology from the information hierarchy, then bind this pack's tokens. If alternatives are requested, vary spatial hierarchy and density, not only the accent color.

## Primary recipe
Top bar (product, library sections, a note that the preview is silent) → sleeve and deck (now playing, position with elapsed and remaining time, three transport keys, shuffle and repeat toggles, volume) beside the album: eyebrow, a large title, artist, facts and a numbered tracklist whose titles are the play controls. The LED marks the current track and on-states only. Below 900px the columns stack.

## Adaptation
For podcasts the tracklist becomes episodes with dates and the deck gains a playback-speed choice. For radio the tracklist becomes stations and the position slider is removed.

## Responsive and long content
Columns stack below 900px and the sleeve shrinks; tracklist rows keep number, title and length on one grid. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text. Do not put content in horizontal scroll regions. Test a long title and translated button text at 320px and 200% text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: keep entered values, say what happened and associate guidance with the control. Success: confirm only what was actually done. Playback state is local and silent; the status line says so on every change.

## Export
Copy the needed CSS and JS beside the generated entry file and update relative paths. The lab toolbar belongs to the catalog only; omit it from client work. No CDN, remote font, brand imitation or borrowed component package is required.

## Turn this recipe into a project

Treat the supplied layout and breakpoints as examples. First identify the primary
operation and choose a reading/action order for this brief; remove sample identity
and irrelevant lab controls. For a second direction, change the topology, density
or type roles in response to a different need, while keeping the system's thesis.

Use the state-coverage design-plan reference to map each visible action to its
validated change and observable result. Include invalid input, no results, Back,
cancellation and repeated use where applicable. Keep user text literal and name
what survives a reload. Test the resulting local export with network unavailable,
then record actual findings and remaining gaps; the recipe is not a test receipt.
