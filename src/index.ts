import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import { config } from './config.js'
import { initSchema } from './db.js'
import { ensureBuckets } from './s3.js'
import { authRoutes } from './auth.js'
import { trackRoutes } from './tracks.js'
import { exportRoutes } from './exports.js'
import { stemRoutes, startStemWorker } from './stems.js'
import { collabRoutes } from './collab.js'
import { battleRoutes } from './battle.js'

const logger = process.env.NODE_ENV === 'production'
  ? true
  : { transport: { target: 'pino-pretty' } }

async function main() {
  const app = Fastify({ logger, bodyLimit: config.maxUploadBytes })

  await app.register(cors, { origin: true, credentials: true })
  await app.register(jwt, { secret: config.jwtSecret })
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes } })

  app.decorate('authenticate', async function (req: any, reply: any) {
    try {
      await req.jwtVerify()
    } catch {
      reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.get('/health', async () => ({ ok: true, service: 'wavdrop-server', ts: Date.now() }))
  app.get('/', async () => ({ service: 'wavdrop-server', version: '0.1.1-hooktest' }))

  await app.register(authRoutes)
  await app.register(trackRoutes)
  await app.register(exportRoutes)
  await app.register(stemRoutes)
  await app.register(collabRoutes)
  await app.register(battleRoutes)

  // Init DB + S3
  await initSchema()
  await ensureBuckets()

  // Start background stem worker in same process (fine for MVP)
  startStemWorker()

  await app.listen({ host: config.host, port: config.port })
  app.log.info(`wavdrop-server listening on ${config.host}:${config.port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
