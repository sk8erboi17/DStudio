---
name: docs
description: A documentation site — three-pane layout (nav · content · on-this-page), first-class code blocks, scannable reference, built to find the answer fast.
modes: [design]
when_to_use: The user wants documentation, a developer guide, API reference, help center, or a knowledge base.
---

# SKILL: docs

People arrive at docs with a question and want out fast. Optimize for **finding** and
**scanning**, not reading cover to cover. Code is a first-class citizen.

## Layout

- **Three panes** on desktop: left **nav** (sections → pages, collapsible, current page
  highlighted), center **content** (a readable measure ~70-80ch), right **"On this page"**
  (the current page's headings, scroll-spy highlights the active one).
- **Top bar**: product/logo, a prominent **search** (⌘K affordance), version switcher,
  light/dark. Search is the most-used control — make it obvious.
- Mobile: nav collapses to a drawer; "on this page" becomes a dropdown.

## Content craft

- **Code blocks** are the centerpiece: monospace, syntax-friendly dark block, a **copy
  button**, a language label, and **tabs** for multi-language examples (curl / JS / Python).
- **Callouts**: note / tip / warning / danger — tinted backgrounds + an icon, used sparingly
  and consistently.
- **Headings** are anchors (hover shows a # link). Clear h2/h3 hierarchy drives the
  on-this-page rail.
- **Tables** for parameters/props: name, type, default, description. Monospace the names.
- **Breadcrumbs** + prev/next page links at the bottom keep people oriented.
- Short paragraphs, lots of headings, examples before prose. Scannable beats eloquent.

## Craft

- Restrained, neutral, high-contrast — docs are read for hours; no eye strain, no
  decoration competing with code.
- The accent marks only: active nav, active on-this-page item, links, and the search focus.
- Consistent spacing so the three panes feel calm and aligned.

## States

Active nav item + active section (scroll-spy), code copied ("Copied!"), search focused,
collapsed nav sections, mobile drawer open, an empty search-results state.

## Self-check before artifact (fix anything < 3/5)

- **Findability**: search prominent, nav clear, on-this-page present?
- **Code**: copy button, language tabs, legible block?
- **Orientation**: do you always know where you are (active nav + breadcrumbs)?
- **Scannability**: heading-dense, examples-first, short paragraphs?
- **Restraint**: neutral, accent only on active/links?

Gate: contrast ≥4.5:1, code block ≥14px mono, keyboard-reachable nav/search, three panes →
single column with drawer at 390, no lorem in nav labels.
