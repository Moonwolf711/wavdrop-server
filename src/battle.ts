import { FastifyInstance, FastifyRequest } from 'fastify'
import { pool } from './db.js'

function makeRoomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

export async function battleRoutes(fastify: FastifyInstance) {
  fastify.post('/battle/create', { preHandler: fastify.authenticate }, async (req) => {
    const userId = (req.user as any).userId
    const code = makeRoomCode()
    const { rows } = await pool.query(
      'INSERT INTO battles (host_user_id, room_code) VALUES ($1,$2) RETURNING id, room_code, created_at',
      [userId, code]
    )
    return rows[0]
  })

  fastify.post(
    '/battle/join/:roomCode',
    { preHandler: fastify.authenticate },
    async (req: FastifyRequest<{ Params: { roomCode: string } }>, reply) => {
      const { rows } = await pool.query(
        "SELECT id, host_user_id, status FROM battles WHERE room_code=$1 AND status='open'",
        [req.params.roomCode]
      )
      if (rows.length === 0) return reply.code(404).send({ error: 'room_closed_or_missing' })
      return rows[0]
    }
  )

  fastify.get('/battle/leaderboard', async () => {
    const { rows } = await pool.query(
      `SELECT u.email, SUM(bs.score) AS total
       FROM battle_scores bs JOIN users u ON u.id=bs.user_id
       GROUP BY u.email ORDER BY total DESC LIMIT 50`
    )
    return { leaderboard: rows }
  })

  fastify.post(
    '/battle/score',
    { preHandler: fastify.authenticate },
    async (req: FastifyRequest<{ Body: { battleId: string; round: number; score: number } }>, reply) => {
      const userId = (req.user as any).userId
      const { battleId, round, score } = req.body || ({} as any)
      if (!battleId || typeof round !== 'number' || typeof score !== 'number') {
        return reply.code(400).send({ error: 'bad_input' })
      }
      await pool.query(
        'INSERT INTO battle_scores (battle_id, user_id, round, score) VALUES ($1,$2,$3,$4)',
        [battleId, userId, round, score]
      )
      return { ok: true }
    }
  )
}
