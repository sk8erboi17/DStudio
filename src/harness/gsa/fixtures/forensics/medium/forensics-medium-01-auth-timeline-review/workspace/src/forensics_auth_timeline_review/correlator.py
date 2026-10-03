from .timeline import Event

def event_weight(event: Event) -> int:
    if event.name == "bulk_read":
        return 9
    if event.name == "mfa_reset":
        return 1
    if event.name.endswith("_success"):
        return 2
    return 1

def summarize(events: list[Event]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for event in events:
        totals[event.user] = totals.get(event.user, 0) + event_weight(event)
    return totals
