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
    id="forensics-impossible-04-cloud-audit-review",
    category="forensics",
    difficulty="impossible",
    scenario="cloud-audit-review",
    review_stream="stream-forensics-impossible-4",
    local_only=True,
)

def label() -> str:
    return f"{CONTEXT.category}:{CONTEXT.difficulty}:{CONTEXT.id}"
