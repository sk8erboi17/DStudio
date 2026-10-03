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
    id="network-security-hard-01-service-exposure-review",
    category="network-security",
    difficulty="hard",
    scenario="service-exposure-review",
    review_stream="stream-network-security-hard-1",
    local_only=True,
)

def label() -> str:
    return f"{CONTEXT.category}:{CONTEXT.difficulty}:{CONTEXT.id}"
