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
    id="crypto-easy-01-jwt-boundary-review",
    category="crypto",
    difficulty="easy",
    scenario="jwt-boundary-review",
    review_stream="stream-crypto-easy-1",
    local_only=True,
)

def label() -> str:
    return f"{CONTEXT.category}:{CONTEXT.difficulty}:{CONTEXT.id}"
