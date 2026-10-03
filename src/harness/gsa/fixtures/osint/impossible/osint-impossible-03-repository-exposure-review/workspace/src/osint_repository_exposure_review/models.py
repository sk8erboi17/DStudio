from dataclasses import dataclass

@dataclass(frozen=True)
class SourceRecord:
    source: str
    observed_at: str
    kind: str
    value: str
    confidence: str

    @property
    def normalized(self) -> str:
        return self.value.strip().lower().replace("_", "-")
