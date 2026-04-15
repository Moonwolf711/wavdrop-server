import { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'

type Room = {
  id: string
  sockets: Set<any>
  state: any
}

const rooms = new Map<string, Room>()

function broadcast(room: Room, payload: any, exceptSocket?: any) {
  const msg = JSON.stringify(payload)
  for (const s of room.sockets) {
    if (s === exceptSocket) continue
    try { s.send(msg) } catch {}
  }
}

export async function collabRoutes(fastify: FastifyInstance) {
  await fastify.register(websocket)

  // Collaboration studio socket: /collab?session=<id>&token=<jwt>
  fastify.get('/collab', { websocket: true }, (socket, req) => {
    const url = new URL(req.url || '', 'http://x')
    const sessionId = url.searchParams.get('session')
    const token = url.searchParams.get('token')
    if (!sessionId || !token) {
      socket.send(JSON.stringify({ type: 'error', error: 'missing_params' }))
      socket.close()
      return
    }

    try {
      fastify.jwt.verify(token)
    } catch {
      socket.send(JSON.stringify({ type: 'error', error: 'unauthorized' }))
      socket.close()
      return
    }

    let room = rooms.get(sessionId)
    if (!room) {
      room = { id: sessionId, sockets: new Set(), state: { deckA: {}, deckB: {}, crossfader: 0.5, effects: {} } }
      rooms.set(sessionId, room)
    }
    room.sockets.add(socket)

    socket.send(JSON.stringify({ type: 'joined', sessionId, state: room.state, peers: room.sockets.size - 1 }))
    broadcast(room, { type: 'peer_joined', peers: room.sockets.size }, socket)

    socket.on('message', (raw: Buffer) => {
      let msg: any
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (!room) return

      switch (msg.type) {
        case 'sync_deck_state':
          room.state = { ...room.state, ...msg.state }
          broadcast(room, { type: 'deck_state', state: room.state }, socket)
          break
        case 'chat_message':
          broadcast(room, { type: 'chat', from: msg.from, text: msg.text, ts: Date.now() })
          break
        case 'webrtc_signal':
          broadcast(room, { type: 'webrtc_signal', signal: msg.signal, from: msg.from }, socket)
          break
      }
    })

    socket.on('close', () => {
      if (!room) return
      room.sockets.delete(socket)
      broadcast(room, { type: 'peer_left', peers: room.sockets.size })
      if (room.sockets.size === 0) rooms.delete(sessionId)
    })
  })

  // Battle socket: /battle?room=<code>&token=<jwt>
  fastify.get('/battle', { websocket: true }, (socket, req) => {
    const url = new URL(req.url || '', 'http://x')
    const roomCode = url.searchParams.get('room')
    const token = url.searchParams.get('token')
    if (!roomCode || !token) { socket.close(); return }
    try { fastify.jwt.verify(token) } catch { socket.close(); return }

    const key = `battle:${roomCode}`
    let room = rooms.get(key)
    if (!room) { room = { id: key, sockets: new Set(), state: { round: 1, scores: {} } }; rooms.set(key, room) }
    room.sockets.add(socket)
    broadcast(room, { type: 'battle_peers', peers: room.sockets.size })

    socket.on('message', (raw: Buffer) => {
      let msg: any; try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type === 'score' && room) {
        room.state.scores[msg.userId] = (room.state.scores[msg.userId] || 0) + (msg.points || 0)
        broadcast(room, { type: 'score_update', scores: room.state.scores })
      }
    })

    socket.on('close', () => {
      if (!room) return
      room.sockets.delete(socket)
      if (room.sockets.size === 0) rooms.delete(key)
    })
  })
}
