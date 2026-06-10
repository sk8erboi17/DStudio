# Third-Party Notices

This repository includes third-party design packs imported from Open Design.

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
by Corey Haines under the MIT License. See `extension/skills/ATTRIBUTION.md`.
