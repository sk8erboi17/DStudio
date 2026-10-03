from dataclasses import dataclass

@dataclass(frozen=True)
class CaseContext:
    id: str
    category: str
    difficulty: str
    scenario: str
    review_stream: str
    local_only: bool

CONTEXT = CaseContext(
    id="osint-easy-04-certificate-transparency-review",
    category="osint",
    difficulty="easy",
    scenario="certificate-transparency-review",
    review_stream="stream-osint-easy-4",
    local_only=True,
)

def label() -> str:
    return f"{CONTEXT.category}:{CONTEXT.difficulty}:{CONTEXT.id}"
