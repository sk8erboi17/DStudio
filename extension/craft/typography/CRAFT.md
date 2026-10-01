---
name: Typography
description: Choose available type roles for the audience, content and density; verify readable hierarchy and enlarged-text reflow.
---

# CRAFT: typography

## Choose roles before sizes

Define display, section, prose, control, metadata and numeric/code roles that the
brief actually needs. Reuse roles consistently; vary scale and density between
an editorial page, an instrument and an editor. A modular scale is a starting
point, not a required number of sizes. User-specified fonts take precedence.

Use actual available weights. Preserve the exact requested family name, load a
supplied local font with `@font-face`, and report an unavailable face honestly.
System fonts and documented fallbacks work offline; naming Inter or a branded
font does not install it. Check the actual fallback's wrapping and glyphs.

## Reading and alignment

For ordinary prose, start near 16px with comfortable line spacing and roughly
60–75 characters per line, then adjust to language, typeface and task. These are
starting values, not a veto on a caption, poster, poem or compact operational row.
Avoid long centered or justified prose. Give code and figures appropriate fonts;
use tabular lining figures and consistent units for numeric comparisons.

Let headings wrap naturally. Use relative minimum sizes in fluid scales and
containers that grow with text. Do not shrink type or clip overflow to fit a
fixed-height card. Check 200% text independently of viewport width, long titles,
translated labels and third/later rows, not just the first ideal example.

## Verify before delivery

Check rendered hierarchy, actual line lengths, truncation and focus readability
at desktop and mobile widths. Inspect cramped prose and enlarged controls.
Keep code bytes and user copy intact while changing visual emphasis. After a
font or width change, rerender every affected layout; a named font or CSS rule is
not evidence of the rendered result.
