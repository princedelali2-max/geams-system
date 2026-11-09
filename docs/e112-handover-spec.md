# GEAMS 112 hand-over: what the 112 operator needs to send

**Why:** a phone cannot tell GEAMS that the user dialled 112. Only the 112 service (or the telecom network) knows. This address lets that service tell GEAMS, so the nearest control room is alerted in parallel with the 112 call. GEAMS does not replace 112 and does not answer the call.

**Setup on the GEAMS server:** set `GEAMS_E112_KEY` to a long random secret and give it to the 112 operator over a secure channel. Rotate it if it leaks (change it and restart). Without the key, the address answers 501 and does nothing.

## Request
`POST https://<your-geams-host>/api/e112/inbound`  
Headers: `Content-Type: application/json`, `X-GEAMS-Key: <the secret>`

```json
{ "callId": "112-2026-0001234",
  "callerPhone": "0244123456",
  "lat": 7.1521, "lng": 0.4722, "accuracyM": 35,
  "type": "fire",
  "note": "Market stall burning",
  "callerName": "optional" }
```
- `callId` (required): the 112 centre's own call number. Sending the same `callId` again is safe: it never creates a second alert (use it for retries).
- `lat`, `lng`: caller location in decimal degrees, inside Ghana. Without a usable location the call is **not lost**: it goes to the HQ inbox for a person to phone the caller back (HTTP 202).
- `type`: free text. Words like fire/burn/smoke become **Fire**; ambulance/medical/injury/accident/bleeding become **Medical**; anything else is **Police**. Wrong guesses are corrected by the control room.
- `note`: up to 500 characters.

## Answers
- `200 {routed:true, station, id}`: delivered to the nearest control room (shown there as "forwarded by 112", critical priority).
- `200 {duplicate:true}`: already delivered.
- `202 {routed:false}`: no usable location; passed to HQ.
- `401` wrong key, `400` missing callId, `429` too many attempts (30 bad keys per 10 minutes per address; 1200 calls an hour), `501` not set up.

## What GEAMS does and does not promise
- The nearest *registered, enabled* control room is chosen by straight-line distance from the location sent. It does not know whether that room is staffed: unanswered alerts are flagged to HQ and neighbours after `GEAMS_ESCALATE_SECS`.
- Delivery is only as good as the operator's system sending it. If the hand-over fails, nothing in GEAMS can detect that a 112 call happened.
- Tested here against a local stand-in, not against a real 112 system.
