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
    id="osint-impossible-03-repository-exposure-review",
    category="osint",
    difficulty="impossible",
    scenario="repository-exposure-review",
    review_stream="stream-osint-impossible-3",
    local_only=True,
)

def label() -> str:
    return f"{CONTEXT.category}:{CONTEXT.difficulty}:{CONTEXT.id}"
