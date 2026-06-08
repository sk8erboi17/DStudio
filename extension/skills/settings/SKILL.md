---
name: settings
description: A settings / preferences area — sectioned navigation, clear controls with helper text, instant or explicit save, and careful destructive actions.
modes: [design]
when_to_use: The user wants a settings page, preferences, account/profile management, or an admin configuration screen.
---

# SKILL: settings

Settings is where users feel in control — or lost. Group well, label clearly, explain the
consequence of each control, and make destructive actions hard to do by accident.

## Structure

- **Sectioned navigation**: a left rail or top tabs (Profile, Account, Notifications,
  Billing, Security, Team, Danger zone). Current section highlighted. Mobile → a list that
  drills in.
- **Each section** = a column of **rows**, each row: a label + one-line helper text on the
  left, the control on the right. Consistent row rhythm; hairline dividers between rows.
- **Group related rows** under a small eyebrow heading. Don't put 20 ungrouped toggles.

## Controls & patterns

- Toggles (instant), selects, text inputs, segmented controls, radio groups — pick the
  right one (toggle = on/off now; radio = pick one of few; select = pick one of many).
- **Helper text** under the label explains what it does and any consequence ("Others on the
  LAN can then reach this app").
- **Save model**: either **auto-save** (show a quiet "Saved" confirmation per change) or an
  explicit **Save bar** that appears when something changed (sticky, "Save / Discard"). Pick
  one and be consistent — don't mix.
- **Avatar / profile**: image upload with a preview, name, email (with a "verify" state if
  unverified).
- **Danger zone**: destructive actions (delete account, leave team, reset) in their own
  section, visually separated (red-outline), behind a **confirm** (type-to-confirm for the
  truly irreversible). Never a lone red button next to normal settings.

## States

Default, focus, a control mid-change + "Saving…/Saved", error on a field, the save bar
appearing, a confirm dialog for destructive actions, disabled/locked rows (e.g. "upgrade to
change"), and mobile drill-in.

## Self-check before artifact (fix anything < 3/5)

- **Grouping**: are related settings grouped with clear eyebrows, not a flat dump?
- **Clarity**: does every control have a label + helper explaining the consequence?
- **Save**: is the save model (auto vs explicit) consistent and obvious?
- **Safety**: are destructive actions separated and confirmed?
- **Restraint**: calm, neutral, accent only on active nav + primary actions?

Gate: contrast ≥4.5:1, controls ≥44px hit area, real labels (not placeholder-only),
destructive actions confirmed, rail → drill-in at 390, realistic values (no "Setting 1").
