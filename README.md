# WavDrop Server

Backend for the WavDrop iOS DJ app. Handles library sync, DJ format exports
(Rekordbox / Serato / Traktor / Engine DJ / Mixxx / djay Pro / VirtualDJ),
BPM & key detection, stem separation, real-time collaboration, and battle mode.

- **Live:** https://wavdrop.76.13.127.240.sslip.io
- **Health:** `GET /health`
- **Source:** TypeScript / Fastify / PostgreSQL / Redis / MinIO / Demucs / librosa

## Stack

| Layer | Tech |
|---|---|
| HTTP + WS | Fastify 5, `@fastify/websocket`, `@fastify/multipart`, `@fastify/jwt` |
| DB | PostgreSQL 16, raw `pg` (no ORM) |
| Queue | BullMQ on Redis 7 |
| Object storage | MinIO (S3-compatible), bucket-per-concern |
| Audio | ffmpeg (transcoding / probe), librosa (BPM + key), Demucs (stem separation) |
| TLS | nginx + Let's Encrypt (auto-renew) |

## Endpoints

### Auth
```
POST /auth/register   { email, password }  → { token, user }
POST /auth/login      { email, password }  → { token, user }
POST /auth/oauth      { provider, idToken, email } → { token, user }
POST /auth/refresh                         → { token }
```

### Library
```
POST   /tracks/upload       multipart(file, title, artist?, album?, genre?)
GET    /tracks              → { tracks: [...] }
DELETE /tracks/:id          → { ok: true }
POST   /tracks/:id/analyze  → { bpm, musical_key, duration_s, sample_rate, bit_depth }
```

### Export (all return presigned S3 download URLs)
```
POST /export/{rekordbox,serato,traktor,engine-dj,virtual-dj,mixxx,djay-pro}
     { trackIds: string[] }
     → { exportId, format, filename, downloadUrl }
```

### Stems
```
POST /stems/separate        { trackId }  → { jobId, status }
GET  /stems/status/:jobId                → { status, progress, ... }
GET  /stems/download/:jobId              → { stems: [{ stem, url }] }
```

### Battle
```
POST /battle/create                     → { id, room_code }
POST /battle/join/:roomCode             → battle record
GET  /battle/leaderboard                → { leaderboard: [...] }
POST /battle/score                      { battleId, round, score }
```

### WebSockets
```
wss://.../collab?session=<id>&token=<jwt>
  client → server: sync_deck_state | chat_message | webrtc_signal
  server → client: joined | deck_state | chat | peer_joined | peer_left

wss://.../battle?room=<code>&token=<jwt>
  client → server: score
  server → client: score_update | battle_peers
```

## Deploy

```bash
# systemd services (all enabled, auto-restart on failure)
systemctl status wavdrop-server minio postgresql redis-server nginx

# tail
journalctl -u wavdrop-server -f
```

## Dev workflow

```bash
# edit locally, push, pull + auto-restart on VPS
git push
ssh root@76.13.127.240 'cd /opt/wavdrop-server && git pull'
# post-merge hook runs `npm install` + `systemctl restart wavdrop-server`
```

## Ports

| Port | Service |
|---|---|
| 443 | nginx (HTTPS, WS, /minio proxy) |
| 80  | nginx (301 → 443) |
| 7781 | wavdrop-server (loopback via nginx) |
| 9000 | MinIO (loopback via /minio) |
| 9001 | MinIO console (not exposed) |
| 5432 | PostgreSQL (loopback) |
| 6379 | Redis (loopback) |

## Verified end-to-end

Register → upload WAV → analyze (120.19 BPM, Dm via librosa) → export Rekordbox →
download 1.57 MB zip containing `rekordbox.xml` + `Music/WAV-DROP/*.wav`.
