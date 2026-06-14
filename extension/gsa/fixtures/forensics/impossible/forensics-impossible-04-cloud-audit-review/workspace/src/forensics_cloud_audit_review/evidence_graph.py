from dataclasses import dataclass
from .timeline import Event

@dataclass(frozen=True)
class EvidenceEdge:
    left: str
    right: str
    relation: str
    confidence: int

def link_events(events: list[Event]) -> list[EvidenceEdge]:
    edges: list[EvidenceEdge] = []
    for prev, cur in zip(events, events[1:]):
        if prev.user == cur.user:
            edges.append(EvidenceEdge(prev.name, cur.name, 'same-user-sequence', 2))
        if cur.name == 'mfa_reset':
            edges.append(EvidenceEdge(cur.user, cur.host, 'identity-control-change', 7))
    return edges
