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
    id="forensics-medium-01-auth-timeline-review",
    category="forensics",
    difficulty="medium",
    scenario="auth-timeline-review",
    review_stream="stream-forensics-medium-1",
    local_only=True,
)

def label() -> str:
    return f"{CONTEXT.category}:{CONTEXT.difficulty}:{CONTEXT.id}"
