# Third-Party Notices

This repository includes third-party packs imported from Open Design and
marketingskills.

## Open Design

- Source: https://github.com/nexu-io/open-design
- Copyright: 2026 Open Design contributors
- Imported from commit: `8123cc69808137ff765aad782e5eabf750249ca5`
- License: Apache License 2.0
- Local license copy: `third_party/open-design/LICENSE`
- Imported locations:
  - `extension/skills/*` entries with `ds4_upstream: open-design/...`
  - `extension/design-systems/*` entries with `ds4_upstream: open-design/...`

The imported Markdown pack files were modified for DStudio/DS4 by adding
`ds4_*` frontmatter metadata and local-first blueprint classification where
provider-backed workflows cannot run directly inside DS4. Modified imported
files carry a `ds4_modified_notice` frontmatter field.

Some imported Open Design skill packs include their own upstream license files
inside the pack directory, commonly MIT or Apache-2.0. Those license files are
retained in place and remain applicable to the corresponding pack content.

## Marketing Skills

DStudio also includes marketing skill content vendored from `marketingskills`
by Corey Haines under the MIT License.

- Source: https://github.com/coreyhaines31/marketingskills
- Copyright: 2025 Corey Haines
- Imported from commit: `7f4af1ea8e7809e0142c55bf19243a706f539c25`
- License: MIT
- Local license copy: `third_party/marketingskills/LICENSE`
- Imported locations:
  - `extension/skills/*` entries with `ds4_upstream: marketingskills/...`

Imported skill Markdown files were modified for DStudio/DS4 by adding
Agent-mode frontmatter, `ds4_*` metadata, category grouping, local catalog
fields, and by renaming upstream `pricing` to `pricing-strategy` to avoid a
collision with DStudio's design-mode pricing page skill. Modified imported
files carry a `ds4_modified_notice` frontmatter field.
