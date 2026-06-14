from dataclasses import dataclass
from datetime import datetime, timezone

@dataclass(frozen=True)
class KeyRecord:
    kid: str
    tenant_id: str
    created_at: datetime
    material_ref: str
    active: bool

class KeyRegistry:
    def __init__(self, records: list[KeyRecord]):
        self._records = records

    def active_for_tenant(self, tenant_id: str) -> KeyRecord:
        candidates = [r for r in self._records if r.tenant_id == tenant_id and r.active]
        if not candidates:
            raise LookupError("no active key")
        return sorted(candidates, key=lambda r: r.created_at, reverse=True)[0]

    @staticmethod
    def demo() -> "KeyRegistry":
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        return KeyRegistry([KeyRecord("k-2026-05", "tenant-a", now, "local-ref", True)])
