# Blueprint live-test fixture: ticket-service

Held-out input for `tests/live/blueprint_live_test.mjs`. It is never shown to
the model as an example. Its structure is the independent oracle in that test:
`api` → `tickets` → (`store`, `cache`, `queue`), `worker` → `queue` (consume) and
`worker` → `notifier`; `index` starts `api` and `worker`. A cache miss reads
`cache.get`, then `store.findTicket`, then `cache.set`.
