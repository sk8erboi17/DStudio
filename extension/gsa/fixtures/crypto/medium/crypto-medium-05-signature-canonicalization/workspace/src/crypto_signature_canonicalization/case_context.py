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
    id="crypto-medium-05-signature-canonicalization",
    category="crypto",
    difficulty="medium",
    scenario="signature-canonicalization",
    review_stream="stream-crypto-medium-5",
    local_only=True,
)

def label() -> str:
    return f"{CONTEXT.category}:{CONTEXT.difficulty}:{CONTEXT.id}"
