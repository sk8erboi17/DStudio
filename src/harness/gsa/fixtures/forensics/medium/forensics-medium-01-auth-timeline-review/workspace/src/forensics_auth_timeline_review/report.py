from .correlator import summarize
from .timeline import load_events

def build_report(path: str) -> str:
    events = load_events(path)
    totals = summarize(events)
    lines = ["user,score"]
    for user, score in sorted(totals.items()):
        lines.append(f"{user},{score}")
    return "\n".join(lines)
