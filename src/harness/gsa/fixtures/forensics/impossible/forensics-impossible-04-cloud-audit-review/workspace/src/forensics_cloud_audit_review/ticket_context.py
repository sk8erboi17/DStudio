def ticket_reference_present(detail: str) -> bool:
    tokens = detail.lower().split()
    return any(token.startswith('ticket-') or token.startswith('chg-') for token in tokens)
