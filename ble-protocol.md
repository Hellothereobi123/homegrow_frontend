# BLE protocol: Pi → app

Contract between the Raspberry Pi (BLE peripheral) and the React Native app (BLE central),
used as an offline fallback when Supabase is unreachable. Both sides implement this document;
if they drift, the transfer fails silently and confusingly, so change it deliberately.

Pi implementation: `pi/ble_protocol.py` (framing) and `pi/ble_server.py` (transport).

## Identity

| What | Value |
|---|---|
| Advertised name | `HydroPi-<hostname>` |
| Service UUID | `6e3a1f80-5c21-4a7e-9d1b-2f8c4a0e7b31` |
| CONTROL characteristic (write) | `6e3a1f81-5c21-4a7e-9d1b-2f8c4a0e7b31` |
| DATA characteristic (notify) | `6e3a1f82-5c21-4a7e-9d1b-2f8c4a0e7b31` |

The service UUID is in the advertisement, so the app can filter its scan by it.

## Exchange

1. App connects and requests an MTU of 517.
2. App subscribes to notifications on DATA.
3. App writes `GET <n>` (ASCII) to CONTROL, e.g. `GET 10`. `n` is clamped to 50.
4. Pi notifies on DATA: one header, then `n` row messages, then one end marker.

Subscribe to DATA **before** writing to CONTROL, or the first notifications are missed.

## Messages

All messages are compact JSON, one per notification, each well under 500 bytes.

```json
{"t":"hdr","cols":["recorded_at","ph","ec","temperature_c","humidity","light_intensity","co2"],"n":10,"sensors_ok":true}
{"t":"row","i":0,"v":["2026-10-09T08:54:20.250000+00:00",6.0,1.12,24.0,62.0,null,820.0]}
{"t":"end"}
```

- `cols` is fixed and ordered; `v` is positional and always the same length as `cols`.
- `i` runs `0 .. n-1`. Use it to confirm nothing was dropped before accepting the transfer.
- Rows are **newest first**.
- `n` may be smaller than requested, including `0`, if the Pi has less history.

### Columns

| Column | Type | Unit | Notes |
|---|---|---|---|
| `recorded_at` | string | ISO 8601, UTC, offset-aware | Latest reading in that cycle |
| `ph` | number | pH | |
| `ec` | number | mS/cm | Matches the Supabase column |
| `temperature_c` | number | °C | Air temperature |
| `humidity` | number | % RH | |
| `light_intensity` | number | lux | Sensor not yet built — currently always `null` |
| `co2` | number | ppm | |

**Any column may be `null`** when that sensor is unimplemented, failed, or missing from the
cycle. Treat `null` as "no reading", not as zero.

These names and units deliberately match the Supabase `sensor_readings` table so the app can
reuse its existing row-mapping path unchanged.

### `sensors_ok`

`false` means the newest reading on the Pi is more than 3 minutes old — the Pi is reachable
but its sensor loop has stalled. Show the data as stale rather than presenting it as current.

### Errors

```json
{"t":"err","msg":"db busy"}
```

`msg` is one of `db busy` (database locked after retries), `bad request` (unparseable CONTROL
write), or `row too large` (a message exceeded one notification; should not happen). On any
error, no `end` marker follows — fail the transfer and let the user retry.

## Notes for the app side

- One row is one **sampling cycle**, not one sensor reading. The Pi stores readings
  individually and pivots them into these wide rows before sending.
- Timestamps are offset-aware UTC. Convert for display rather than assuming local time.
- A second `GET` while a transfer is in flight is ignored, so a double tap is harmless but
  will not restart the transfer — wait for `end` or the timeout.
- This path is **read-only**. There is no command or write capability, by design: the phone
  cannot influence dosing or the control loop over BLE.
