// Questions fixed before the full-pipeline live run. Oracles are public primary
// sources, independently inspected on 2026-09-06; regex checks are provisional
// and every final answer still requires a recorded semantic review.
export const researchPipelineCases = [
  { id: 'http-retry-header', mode: 'search',
    question: 'According to RFC 6585, is Retry-After mandatory in an HTTP 429 response, and what does 429 mean? Verify the RFC on the web and answer briefly with a citation.',
    primary: ['https://www.rfc-editor.org/rfc/rfc6585'],
    expected: ['429 describes rate limiting / too many requests.', 'Retry-After is optional (MAY), not mandatory.'],
  },
  { id: 'python-versioned-suffix', mode: 'search',
    question: 'Read https://docs.python.org/3.14/library/pathlib.html . In which Python version did a single dot become a valid pathlib suffix, and what is PurePosixPath("report.").suffix in that version? Cite the documentation and keep the answer short.',
    primary: ['https://docs.python.org/3.14/library/pathlib.html'],
    expected: ['The documented change is Python 3.14.', 'The suffix is a single dot, not an empty string.'],
  },
  { id: 'venus-rotation-orbit', mode: 'research',
    question: 'Find NASA evidence for this narrow question: how long does Venus take to rotate once and to orbit the Sun, in Earth days? Which takes longer? Distinguish a full rotation from daylight duration. Give a concise cited report, at most 250 words, and state any evidence gap.',
    primary: ['https://science.nasa.gov/venus/'],
    expected: ['Full rotation is about 243 Earth days.', 'Orbit is about 225 Earth days.', 'A full rotation takes longer than an orbit; daylight duration is not the rotation period.'],
  },
  { id: 'accessible-target-comparison', mode: 'research',
    question: 'Compare W3C WCAG 2.2 Target Size (Minimum), SC 2.5.8, with Target Size (Enhanced), SC 2.5.5. Read https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html and https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html . State the CSS-pixel dimensions and conformance level of each, and whether inline links within sentences are an exception. Keep the cited report below 250 words; do not treat the enhanced value as the minimum.',
    primary: ['https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html', 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html'],
    expected: ['Minimum: 24 by 24 CSS pixels, level AA.', 'Enhanced: 44 by 44 CSS pixels, level AAA.', 'Inline targets within sentences have an exception.'],
  },
];
