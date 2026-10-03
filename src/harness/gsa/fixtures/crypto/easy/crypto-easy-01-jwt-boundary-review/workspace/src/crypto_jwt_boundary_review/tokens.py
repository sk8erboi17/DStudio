import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

@dataclass(frozen=True)
class ResetToken:
    subject: str
    issued_at: datetime
    expires_at: datetime
    token: str

def mint_reset_token(subject: str, ttl_minutes: int = 15) -> ResetToken:
    issued = datetime.now(timezone.utc)
    return ResetToken(subject, issued, issued + timedelta(minutes=ttl_minutes), secrets.token_urlsafe(32))
