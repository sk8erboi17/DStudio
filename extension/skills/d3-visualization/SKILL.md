---
name: d3-visualization
description: |
  Teaches the agent to produce D3 charts and interactive data visualizations. A comprehensive D3.js skill with examples across chart types and techniques giving the agent expert-level knowledge to generate complex, interactive visualizations. Useful for editorial dashboards, reports, data-rich prototypes, and explanatory graphics.
triggers:
  - "d3"
  - "d3.js"
  - "interactive chart"
  - "data visualization"
  - "editorial chart"
  - "d3 bar chart"
  - "d3 line chart"
  - "d3 map"
  - "d3 force graph"
  - "d3 sankey"
  - "d3 treemap"
  - "d3 sunburst"
  - "d3 choropleth"
  - "d3 animation"
  - "d3 scroll"
  - "snow-d3"
od:
  mode: prototype
  category: diagrams
  upstream: "https://github.com/jiannanya/snow-d3/"
ds4_category: data-visualization
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: open-design/d3-visualization
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# d3-visualization

> Curated from @jiannanya.

## What it does

Teaches the agent to produce D3 charts and interactive data visualizations. A comprehensive D3.js skill with examples across chart types and techniques giving the agent expert-level knowledge to generate complex, interactive visualizations. Useful for editorial dashboards, reports, data-rich prototypes, and explanatory graphics.

## Source

- Upstream: https://github.com/jiannanya/snow-d3/
- Category: `diagrams`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and reference documents, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/jiannanya/snow-d3/

# Clone or copy the snow-d3/ folder into your workspace's skills/ directory
git clone https://github.com/jiannanya/snow-d3.git skills/snow-d3

```

Then ask the agent to invoke this skill by name (`d3-visualization`) or with
one of the trigger phrases listed in this skill's frontmatter, e.g.:

> "Create a zoomable treemap for my sales data"
> "Build a force-directed network graph like example 07 but for my own dataset"
> "Generate a calendar heatmap in D3"
