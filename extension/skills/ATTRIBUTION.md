# Attribution

The marketing skills (`ds4_upstream: marketingskills/...`) are vendored from
**marketingskills** by **Corey Haines**, used under the MIT License.
Source: https://github.com/coreyhaines31/marketingskills
Imported commit: `7f4af1ea8e7809e0142c55bf19243a706f539c25`

The imported skills were adapted for DStudio/DS4 with Agent-mode discovery,
DS4 category metadata, and local catalog fields. The upstream `pricing` skill
is imported as `pricing-strategy` to avoid colliding with DStudio's design-mode
pricing page skill. Modified imported files carry a `ds4_modified_notice`
frontmatter field. See `../../THIRD_PARTY_NOTICES.md` and
`../../third_party/marketingskills/LICENSE`.

```
MIT License
Copyright (c) 2025 Corey Haines

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Some design skills and design systems are imported from **Open Design** by
Nexu under the Apache License 2.0 and adapted for DStudio/DS4 with local-first
metadata. See `../../THIRD_PARTY_NOTICES.md` and
`../../third_party/open-design/LICENSE`.

Some imported Open Design skill packs carry their own upstream license files
inside the pack directory. Those files are retained in place and remain
applicable to the corresponding pack content.

Craft packs and DStudio-authored design skills/design systems remain DStudio's own
unless a pack carries a `ds4_upstream` field or an included license file saying
otherwise.
