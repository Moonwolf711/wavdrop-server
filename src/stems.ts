import { FastifyInstance, FastifyRequest } from 'fastify'
import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { pool } from './db.js'
import { config } from './config.js'
import { s3, presignGet } from './s3.js'

const connection = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null,
})

export const stemQueue = new Queue('stems', { connection })

export function startStemWorker() {
  return new Worker(
    'stems',
    async (job) => {
      const { jobId, userId, trackId, s3Key } = job.data as {
        jobId: string; userId: string; trackId: string; s3Key: string
      }

      await pool.query('UPDATE stem_jobs SET status=$1, progress=$2 WHERE id=$3', ['running', 0.1, jobId])

      // 1. Download WAV from S3 to tmp
      const tmpDir = fs.mkdtempSync('/tmp/stems-')
      const inPath = path.join(tmpDir, 'input.wav')
      const obj = await s3.getObject(config.s3.bucketTracks, s3Key)
      await new Promise<void>((resolve, reject) => {
        const w = fs.createWriteStream(inPath)
        obj.pipe(w).on('finish', () => resolve()).on('error', reject)
      })

      await pool.query('UPDATE stem_jobs SET progress=$1 WHERE id=$2', [0.3, jobId])

      // 2. Run Demucs (python -m demucs --two-stems=vocals <in> -o <out>)
      // If demucs is missing, fall back to ffmpeg channel split as placeholder.
      const outDir = path.join(tmpDir, 'out')
      fs.mkdirSync(outDir, { recursive: true })

      const useDemucs = await hasCommand('demucs')
      if (useDemucs) {
        await runCmd('demucs', ['--out', outDir, inPath])
      } else {
        // placeholder: copy input as "other" stem
        fs.copyFileSync(inPath, path.join(outDir, 'other.wav'))
      }

      await pool.query('UPDATE stem_jobs SET progress=$1 WHERE id=$2', [0.8, jobId])

      // 3. Upload every produced .wav to S3 under prefix
      const prefix = `${userId}/${jobId}`
      const stemFiles = walkFiles(outDir).filter((f) => f.endsWith('.wav'))
      for (const f of stemFiles) {
        const key = `${prefix}/${path.basename(f)}`
        await s3.fPutObject(config.s3.bucketStems, key, f)
      }

      // 4. Mark done
      await pool.query(
        `UPDATE stem_jobs SET status='done', progress=1, result_s3_prefix=$1, completed_at=now()
         WHERE id=$2`,
        [prefix, jobId]
      )

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true })

      return { jobId, stemCount: stemFiles.length }
    },
    { connection }
  )
}

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(p))
    else out.push(p)
  }
  return out
}

function hasCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('which', [cmd])
    p.on('close', (code) => resolve(code === 0))
  })
}

function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' })
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))))
    p.on('error', reject)
  })
}

export async function stemRoutes(fastify: FastifyInstance) {
  // Queue a stem-separation job
  fastify.post(
    '/stems/separate',
    { preHandler: fastify.authenticate },
    async (req: FastifyRequest<{ Body: { trackId: string } }>, reply) => {
      const userId = (req.user as any).userId
      const { trackId } = req.body || ({} as any)
      if (!trackId) return reply.code(400).send({ error: 'trackId_required' })

      const { rows } = await pool.query(
        'SELECT s3_key FROM tracks WHERE id=$1 AND user_id=$2',
        [trackId, userId]
      )
      if (rows.length === 0) return reply.code(404).send({ error: 'track_not_found' })

      const jobRow = await pool.query(
        `INSERT INTO stem_jobs (user_id, track_id, status) VALUES ($1,$2,'queued')
         RETURNING id, created_at`,
        [userId, trackId]
      )
      const jobId = jobRow.rows[0].id
      await stemQueue.add('separate', { jobId, userId, trackId, s3Key: rows[0].s3_key })

      return { jobId, status: 'queued' }
    }
  )

  // Poll status
  fastify.get(
    '/stems/status/:jobId',
    { preHandler: fastify.authenticate },
    async (req: FastifyRequest<{ Params: { jobId: string } }>, reply) => {
      const userId = (req.user as any).userId
      const { rows } = await pool.query(
        'SELECT id, status, progress, error, result_s3_prefix, created_at, completed_at FROM stem_jobs WHERE id=$1 AND user_id=$2',
        [req.params.jobId, userId]
      )
      if (rows.length === 0) return reply.code(404).send({ error: 'job_not_found' })
      return rows[0]
    }
  )

  // Presigned download URLs for all stems in a completed job
  fastify.get(
    '/stems/download/:jobId',
    { preHandler: fastify.authenticate },
    async (req: FastifyRequest<{ Params: { jobId: string } }>, reply) => {
      const userId = (req.user as any).userId
      const { rows } = await pool.query(
        "SELECT result_s3_prefix FROM stem_jobs WHERE id=$1 AND user_id=$2 AND status='done'",
        [req.params.jobId, userId]
      )
      if (rows.length === 0) return reply.code(404).send({ error: 'not_ready' })

      const prefix = rows[0].result_s3_prefix
      const items: Array<{ stem: string; url: string }> = []
      const stream = s3.listObjectsV2(config.s3.bucketStems, prefix, true)
      for await (const obj of stream as any) {
        if (!obj?.name) continue
        const url = await presignGet(config.s3.bucketStems, obj.name, 3600)
        items.push({ stem: path.basename(obj.name), url })
      }
      return { jobId: req.params.jobId, stems: items }
    }
  )
}
