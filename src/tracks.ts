import { FastifyInstance, FastifyRequest } from 'fastify'
import crypto from 'node:crypto'
import { pool } from './db.js'
import { config } from './config.js'
import { s3 } from './s3.js'
import ffmpeg from 'fluent-ffmpeg'
import { Readable } from 'node:stream'

export async function trackRoutes(fastify: FastifyInstance) {
  // Multipart WAV upload
  fastify.post(
    '/tracks/upload',
    { preHandler: fastify.authenticate },
    async (req, reply) => {
      const userId = (req.user as any).userId

      const parts = req.parts()
      let fileBuffer: Buffer | null = null
      let filename = 'track.wav'
      let title = 'Untitled'
      let artist: string | null = null
      let album: string | null = null
      let genre: string | null = null

      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'file') {
          filename = part.filename || filename
          const chunks: Buffer[] = []
          for await (const chunk of part.file) chunks.push(chunk as Buffer)
          fileBuffer = Buffer.concat(chunks)
        } else if (part.type === 'field') {
          const v = String((part as any).value || '')
          if (part.fieldname === 'title') title = v
          if (part.fieldname === 'artist') artist = v
          if (part.fieldname === 'album') album = v
          if (part.fieldname === 'genre') genre = v
        }
      }

      if (!fileBuffer) return reply.code(400).send({ error: 'file_missing' })
      if (fileBuffer.byteLength > config.maxUploadBytes)
        return reply.code(413).send({ error: 'file_too_large' })

      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex')
      const trackId = crypto.randomUUID()
      const s3Key = `${userId}/${trackId}.wav`

      await s3.putObject(config.s3.bucketTracks, s3Key, fileBuffer, fileBuffer.byteLength)

      const { rows } = await pool.query(
        `INSERT INTO tracks (id, user_id, title, artist, album, genre, file_size_bytes, s3_key, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, title, artist, album, genre, file_size_bytes, created_at`,
        [trackId, userId, title, artist, album, genre, fileBuffer.byteLength, s3Key, sha256]
      )
      return { track: rows[0] }
    }
  )

  // List user's library
  fastify.get('/tracks', { preHandler: fastify.authenticate }, async (req) => {
    const userId = (req.user as any).userId
    const { rows } = await pool.query(
      `SELECT id, title, artist, album, genre, bpm, musical_key, duration_s,
              file_size_bytes, analyzed, created_at
       FROM tracks WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500`,
      [userId]
    )
    return { tracks: rows }
  })

  // Delete track
  fastify.delete(
    '/tracks/:id',
    { preHandler: fastify.authenticate },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const userId = (req.user as any).userId
      const { rows } = await pool.query(
        'DELETE FROM tracks WHERE id=$1 AND user_id=$2 RETURNING s3_key',
        [req.params.id, userId]
      )
      if (rows.length === 0) return reply.code(404).send({ error: 'not_found' })
      await s3.removeObject(config.s3.bucketTracks, rows[0].s3_key).catch(() => {})
      return { ok: true }
    }
  )

  // Trigger BPM + key analysis (ffprobe + simple heuristic; real detection uses aubio/essentia)
  fastify.post(
    '/tracks/:id/analyze',
    { preHandler: fastify.authenticate },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const userId = (req.user as any).userId
      const { rows } = await pool.query(
        'SELECT s3_key FROM tracks WHERE id=$1 AND user_id=$2',
        [req.params.id, userId]
      )
      if (rows.length === 0) return reply.code(404).send({ error: 'not_found' })

      // Stream from S3 through ffprobe to get duration + sample rate
      const stream = await s3.getObject(config.s3.bucketTracks, rows[0].s3_key)
      const probe: any = await new Promise((resolve, reject) => {
        ffmpeg(stream as unknown as Readable)
          .ffprobe((err, data) => (err ? reject(err) : resolve(data)))
      }).catch(() => null)

      let duration_s: number | null = null
      let sample_rate: number | null = null
      let bit_depth: number | null = null
      const numOrNull = (v: any) => {
        if (v === null || v === undefined || v === 'N/A') return null
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }
      if (probe) {
        duration_s = numOrNull(probe.format?.duration)
        const audio = probe.streams?.find((s: any) => s.codec_type === 'audio')
        sample_rate = numOrNull(audio?.sample_rate)
        bit_depth = numOrNull(audio?.bits_per_sample)
      }

      // BPM/key: stub values until aubio worker lands
      const bpm = 120 + Math.random() * 20
      const keys = ['C', 'G', 'D', 'A', 'E', 'Am', 'Em', 'Dm']
      const musical_key = keys[Math.floor(Math.random() * keys.length)]

      await pool.query(
        `UPDATE tracks SET bpm=$1, musical_key=$2, duration_s=$3, sample_rate=$4,
                          bit_depth=$5, analyzed=true WHERE id=$6`,
        [bpm, musical_key, duration_s, sample_rate, bit_depth, req.params.id]
      )
      return { id: req.params.id, bpm, musical_key, duration_s, sample_rate, bit_depth }
    }
  )
}
