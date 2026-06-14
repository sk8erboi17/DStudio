import hashlib
import hmac

def canonical_request(method: str, path: str, body: bytes) -> bytes:
    normalized = '\n'.join([method.upper(), path.strip(), hashlib.sha256(body).hexdigest()])
    return normalized.encode('utf-8')

def sign_request(secret_ref: str, method: str, path: str, body: bytes) -> str:
    return hmac.new(secret_ref.encode('utf-8'), canonical_request(method, path, body), hashlib.sha256).hexdigest()
