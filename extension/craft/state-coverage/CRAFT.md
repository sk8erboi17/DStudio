---
name: State coverage
description: Map actual actions to validated state and visible outcomes; preserve input, cancellation, recovery and honest persistence.
---

# CRAFT: state coverage

## Plan only what this brief needs

Read `references/design-plan.md` with `pack_file` and write the project-specific
plan before substantial implementation. Use concrete records/actions and expected
results, not a long generic checklist. Update it after a material change; omit
inapplicable states with a reason instead of inventing unnecessary screens.

## Data and operation states

- Initial/empty: explain what is absent and expose an implemented next action.
- Loading: retain useful prior content and input; use real or indeterminate
  progress. Match the layout without implying a completed operation.
- Populated: use coherent, sourced or explicitly illustrative data and expose
  selection, quantities and statuses in words.
- Error: identify the failed operation/field, retain prior valid data and drafts,
  and provide a real recovery path. Cancellation is a separate outcome.
- Edge: test no/one/many records, long strings, invalid/nonfinite values and
  missing optional data. Bound retained data and history where used.

Do not add simulated failures or timers to a live product just to display every
state. Isolated browser fixtures can exercise real pending/error transitions.

## Action and ownership contract

For every visible action identify input, validation, committed owner and result.
Prepare edits privately, revalidate the selected record/request before commit,
and derive counters/details from that same state. Duplicate clicks must not
repeat an external effect; stale callbacks cannot overwrite a newer selection.
Retain useful hover/focus/selected/disabled feedback with understandable reasons.

Separate drafts from committed values. Back/Undo restores only supported recorded
changes; cancelled interactions preserve previous results. New streamed text
must preserve reading position, focus and selected text. A response failure keeps
already received content and reports incomplete status honestly.

## Persistence and evidence

Declare what survives reload, what stays local and what is actually sent/saved.
A demo click cannot claim delivery, payment, booking or a physical-device change.
Verify tool/file results independently of animation or model text. Exercise valid,
invalid, cancelled and repeated actions, reopen where supported, and record actual
outcomes and not-run checks. A plan is guidance, not a passing test receipt.
