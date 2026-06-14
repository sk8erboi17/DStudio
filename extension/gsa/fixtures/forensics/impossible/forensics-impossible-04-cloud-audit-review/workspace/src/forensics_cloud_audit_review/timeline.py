from dataclasses import dataclass
from datetime import datetime, timezone
import csv

@dataclass(frozen=True)
class Event:
    ts: datetime
    source: str
    name: str
    user: str
    host: str
    detail: str

def parse_ts(raw: str) -> datetime:
    value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return value.astimezone(timezone.utc)

def load_events(path: str) -> list[Event]:
    events: list[Event] = []
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            events.append(Event(parse_ts(row["timestamp"]), row["source"], row["event"], row["user"], row["host"], row["detail"]))
    return sorted(events, key=lambda item: item.ts)
