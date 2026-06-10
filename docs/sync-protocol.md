# Clutch Server Sync Protocol

Wire protocol for syncing Clutch state through a server using `WebSocketTransport`
(`@bkincz/clutch/sync-ws`). The server is a **stamping relay**: it orders messages and
broadcasts them. It does not need to understand Immer patches or hold application state.

All frames are JSON text messages.

## Client → Server

### State messages

Sent whenever local state mutates (debounced by `syncDebounce`):

```jsonc
// mergeStrategy: 'latest'
{
  "type": "state_update",
  "instanceId": "instance_1781070740908_vs6znzn", // unique per client instance
  "timestamp": 1781070740908,                     // client clock, informational only
  "state": { /* full state */ },
  "description": "increment count"                // optional
}

// mergeStrategy: 'patches'
{
  "type": "patches",
  "instanceId": "instance_...",
  "timestamp": 1781070740908,
  "patches": [{ "op": "replace", "path": ["count"], "value": 5 }],
  "inversePatches": [{ "op": "replace", "path": ["count"], "value": 4 }]
}
```

### Resync request

Sent on connect, on reconnect, and when a client detects a version gap:

```jsonc
{ "type": "full_sync", "instanceId": "instance_...", "timestamp": 1781070740908 }
```

### Heartbeat

```jsonc
{ "type": "ping" }
```

### Auth (optional)

With `authMode: 'message'`, the first frame after the socket opens is:

```jsonc
{ "type": "auth", "token": "..." }
```

With `authMode: 'query'` (default), the token is appended to the URL instead:
`wss://example.com/sync?token=...`

## Server → Client

### Version stamping (required)

For every inbound `state_update` or `patches` message, the server MUST:

1. Increment a **single monotonic counter** per channel/room (start at 1).
2. Attach it as `version` to the message.
3. **Broadcast the stamped message to ALL clients in the channel — INCLUDING the
   sender.** The echo is how the sender advances its own version cursor; without it,
   every mutation the sender makes causes the next inbound message to look like a
   version gap, triggering needless resync churn. There is no separate ack type.

```jsonc
{
  "type": "patches",
  "instanceId": "instance_...",   // Unchanged. Clients use it to ignore their own echo
  "timestamp": 1781070740908,
  "patches": [ /* unchanged */ ],
  "version": 42                    // Server-assigned, monotonic
}
```

Clients order strictly by `version` and ignore `timestamp` on versioned messages
(client clocks cannot be trusted across machines). Versioned messages with
`version <= lastSeen` are dropped as duplicates. A `patches` message that skips a
version is dropped and answered with a `full_sync` request; a `state_update` is
self-contained, so gaps are tolerated.

### Resync relay

On `full_sync`, relay the request verbatim to all **other** clients in the channel.
One of them responds with a full `state_update`, which gets stamped and broadcast as
usual. (Optional optimization: a server that caches the last full state may answer
`full_sync` directly with a stamped `state_update`.)

### Heartbeat reply

Answer `ping` with:

```jsonc
{ "type": "pong" }
```

`pong` frames are consumed by the transport and never reach application code.

## Minimal server pseudocode

```js
// per channel
let version = 0
const clients = new Set()

function onMessage(sender, msg) {
  switch (msg.type) {
    case 'state_update':
    case 'patches':
      msg.version = ++version
      for (const c of clients) c.send(JSON.stringify(msg)) // including sender!
      break
    case 'full_sync':
      for (const c of clients) if (c !== sender) c.send(JSON.stringify(msg))
      break
    case 'ping':
      sender.send(JSON.stringify({ type: 'pong' }))
      break
    case 'auth':
      // validate msg.token; close the socket on failure
      break
  }
}
```

## Security expectations

Clutch validates inbound payload structure and rejects prototype-pollution attempts,
but the server owns real authorization:

- Authenticate connections (token via query param or `auth` frame).
- Authorize per channel/room - patches can address **any path** in the state, so a
  client allowed into a channel can write all of its synced state.
- Enforce message size limits and rate limits server-side.

## Serialization caveat

WebSocket frames are JSON. State containing `Date`, `Map`, `Set`, `undefined`, or
class instances survives BroadcastChannel's structured clone but **not** JSON. Keep
server-synced state JSON-serializable.
