import { FastifyInstance, FastifyRequest } from 'fastify'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { pool } from './db.js'

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

export async function authRoutes(fastify: FastifyInstance) {
  // Email/password register
  fastify.post('/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() })

    const { email, password } = parsed.data
    const hash = await bcrypt.hash(password, 12)
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
        [email, hash]
      )
      const token = fastify.jwt.sign({ userId: rows[0].id, email: rows[0].email })
      return { token, user: rows[0] }
    } catch (e: any) {
      if (e.code === '23505') return reply.code(409).send({ error: 'email_taken' })
      throw e
    }
  })

  // Email/password login
  fastify.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() })

    const { email, password } = parsed.data
    const { rows } = await pool.query('SELECT id, email, password_hash FROM users WHERE email=$1', [email])
    if (rows.length === 0) return reply.code(401).send({ error: 'invalid_credentials' })
    const ok = await bcrypt.compare(password, rows[0].password_hash || '')
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' })

    const token = fastify.jwt.sign({ userId: rows[0].id, email: rows[0].email })
    return { token, user: { id: rows[0].id, email: rows[0].email } }
  })

  // OAuth stubs (Apple / Google) — verify idToken server-side in prod
  fastify.post('/auth/oauth', async (req: FastifyRequest<{ Body: { provider: string; idToken: string; email?: string } }>, reply) => {
    const { provider, email } = req.body || ({} as any)
    if (!email) return reply.code(400).send({ error: 'email_required_in_stub' })

    const { rows } = await pool.query(
      `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email
       RETURNING id, email`,
      [email]
    )
    const token = fastify.jwt.sign({ userId: rows[0].id, email: rows[0].email, provider })
    return { token, user: rows[0] }
  })

  // JWT refresh (short-lived access pattern could go here)
  fastify.post('/auth/refresh', { preHandler: fastify.authenticate }, async (req) => {
    const payload = req.user as { userId: string; email: string }
    const token = fastify.jwt.sign({ userId: payload.userId, email: payload.email })
    return { token }
  })
}

export async function authPlugin(fastify: FastifyInstance) {
  fastify.decorate('authenticate', async function (req: FastifyRequest, reply: any) {
    try {
      await req.jwtVerify()
    } catch {
      reply.code(401).send({ error: 'unauthorized' })
    }
  })
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: any
  }
  interface FastifyRequest {
    user: { userId: string; email: string }
  }
}
