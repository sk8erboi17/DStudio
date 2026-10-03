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
    id="network-security-medium-02-dns-egress-review",
    category="network-security",
    difficulty="medium",
    scenario="dns-egress-review",
    review_stream="stream-network-security-medium-2",
    local_only=True,
)

def label() -> str:
    return f"{CONTEXT.category}:{CONTEXT.difficulty}:{CONTEXT.id}"
