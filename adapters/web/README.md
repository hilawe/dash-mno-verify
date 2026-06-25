# Web gate adapter

Gates a web session behind anonymous masternode verification. It uses no web framework,
only `node:http`, and it talks to the same gateway endpoints as every other adapter.

```bash
export MNO_GATEWAY_URL=http://127.0.0.1:8787
export MNO_WEB_COMMUNITY=example.org   # scopes the context hash for this site
export MNO_WEB_PORT=8080
npm run web                            # add this script, or: node adapters/web/server.js
```

## Routes

- `GET /` the landing page with the verify flow.
- `POST /api/start` asks the gateway for a challenge and returns it for download.
- `POST /api/submit` forwards the proof to the gateway and, on success, marks the session verified.
- `GET /members` the gated area, served only to a verified session.

## Flow

1. The visitor clicks "Get challenge", which downloads `challenge.json`.
2. They run the prover locally with their voting key and that challenge.
3. They upload `proof.json`. The adapter verifies it through the gateway and grants the session until the epoch ends.

## Notes for production

The session store here is in memory and the cookie is unsigned, which is fine for a
reference adapter. A real deployment should use signed, persisted sessions and serve over
HTTPS. None of that touches the gateway contract, which stays identical.
