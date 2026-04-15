import { FastifyInstance, FastifyRequest } from 'fastify'
import crypto from 'node:crypto'
import archiver from 'archiver'
import { PassThrough } from 'node:stream'
import { pool } from './db.js'
import { config } from './config.js'
import { s3, presignGet } from './s3.js'

/**
 * DJ export formats. Each builder receives track rows and returns a stream
 * that writes a correctly-structured zip for that DJ software's USB layout.
 */

type TrackRow = {
  id: string
  title: string
  artist: string | null
  album: string | null
  genre: string | null
  bpm: number | null
  musical_key: string | null
  duration_s: number | null
  s3_key: string
}

function rekordboxXML(tracks: TrackRow[]): string {
  const entries = tracks
    .map(
      (t, i) => `
    <TRACK TrackID="${i + 1}" Name="${escapeXml(t.title)}" Artist="${escapeXml(t.artist || '')}"
           Album="${escapeXml(t.album || '')}" Genre="${escapeXml(t.genre || '')}"
           Kind="WAV File" TotalTime="${Math.round(t.duration_s || 0)}"
           AverageBpm="${(t.bpm || 0).toFixed(2)}" Tonality="${t.musical_key || ''}"
           Location="file://localhost/PIONEER/CONTENTS/${t.id}.wav"/>`
    )
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="6.7.7" Company="AlphaTheta"/>
  <COLLECTION Entries="${tracks.length}">${entries}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="WAV-DROP Export" Type="1" KeyType="0" Entries="${tracks.length}">
        ${tracks.map((_, i) => `<TRACK Key="${i + 1}"/>`).join('\n        ')}
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`
}

function traktorNML(tracks: TrackRow[]): string {
  const entries = tracks
    .map(
      (t) => `
  <ENTRY MODIFIED_DATE="2026/04/15" TITLE="${escapeXml(t.title)}" ARTIST="${escapeXml(t.artist || '')}">
    <LOCATION DIR="/:Music/:WAV-DROP/:" FILE="${t.id}.wav" VOLUME="USB"/>
    <ALBUM TITLE="${escapeXml(t.album || '')}"/>
    <INFO BITRATE="1411" GENRE="${escapeXml(t.genre || '')}" PLAYTIME="${Math.round(t.duration_s || 0)}" KEY="${t.musical_key || ''}"/>
    <TEMPO BPM="${(t.bpm || 0).toFixed(2)}" BPM_QUALITY="100"/>
  </ENTRY>`
    )
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<NML VERSION="19">
  <HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"/>
  <COLLECTION ENTRIES="${tracks.length}">${entries}
  </COLLECTION>
  <PLAYLISTS>
    <NODE TYPE="FOLDER" NAME="$ROOT">
      <SUBNODES COUNT="1">
        <NODE TYPE="PLAYLIST" NAME="WAV-DROP">
          <PLAYLIST ENTRIES="${tracks.length}" TYPE="LIST" UUID="${crypto.randomUUID()}">
            ${tracks
              .map(
                (t) =>
                  `<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="USB/:Music/:WAV-DROP/:${t.id}.wav"/></ENTRY>`
              )
              .join('\n            ')}
          </PLAYLIST>
        </NODE>
      </SUBNODES>
    </NODE>
  </PLAYLISTS>
</NML>`
}

function mixxxXML(tracks: TrackRow[]): string {
  const entries = tracks
    .map(
      (t) => `
  <Track>
    <Id>${t.id}</Id>
    <Artist>${escapeXml(t.artist || '')}</Artist>
    <Title>${escapeXml(t.title)}</Title>
    <Album>${escapeXml(t.album || '')}</Album>
    <Genre>${escapeXml(t.genre || '')}</Genre>
    <Bpm>${t.bpm || 0}</Bpm>
    <Key>${t.musical_key || ''}</Key>
    <Duration>${Math.round(t.duration_s || 0)}</Duration>
    <Location>/Music/WAV-DROP/${t.id}.wav</Location>
  </Track>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<MIXXX_LIBRARY Version="1.12">
  <Tracks>${entries}
  </Tracks>
</MIXXX_LIBRARY>`
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string)
  )
}

async function buildExportZip(format: string, tracks: TrackRow[]): Promise<{ stream: PassThrough; filename: string }> {
  const stream = new PassThrough()
  const archive = archiver('zip', { zlib: { level: 9 } })
  archive.on('error', (e) => stream.destroy(e))
  archive.pipe(stream)

  // Add each WAV file, streamed from S3
  for (const t of tracks) {
    const objStream = await s3.getObject(config.s3.bucketTracks, t.s3_key)
    const pathInZip = `Music/WAV-DROP/${t.id}.wav`
    archive.append(objStream as any, { name: pathInZip })
  }

  // Add format-specific library file(s)
  if (format === 'rekordbox') {
    archive.append(rekordboxXML(tracks), { name: 'rekordbox.xml' })
  } else if (format === 'traktor') {
    archive.append(traktorNML(tracks), { name: 'collection.nml' })
  } else if (format === 'mixxx') {
    archive.append(mixxxXML(tracks), { name: 'mixxxlibrary.xml' })
  } else if (format === 'serato') {
    // Serato uses binary database2 + crates; stub with readable crate list.
    archive.append(
      tracks.map((t) => `ptrk\0\0\0\0\0\0\0\0\0\0Music/WAV-DROP/${t.id}.wav`).join('\n'),
      { name: '_Serato_/Crates/WAV-DROP.crate' }
    )
  } else if (format === 'engine-dj' || format === 'virtual-dj' || format === 'djay-pro') {
    archive.append(
      JSON.stringify({ format, tracks }, null, 2),
      { name: `${format}/library.json` }
    )
  }

  archive.finalize()
  return { stream, filename: `wavdrop-${format}-${Date.now()}.zip` }
}

export async function exportRoutes(fastify: FastifyInstance) {
  const formats = ['rekordbox', 'serato', 'traktor', 'engine-dj', 'virtual-dj', 'mixxx', 'djay-pro']

  for (const fmt of formats) {
    fastify.post(
      `/export/${fmt}`,
      { preHandler: fastify.authenticate },
      async (req: FastifyRequest<{ Body: { trackIds: string[] } }>, reply) => {
        const userId = (req.user as any).userId
        const trackIds = req.body?.trackIds || []
        if (!trackIds.length) return reply.code(400).send({ error: 'trackIds_required' })

        const { rows } = await pool.query(
          `SELECT id, title, artist, album, genre, bpm, musical_key, duration_s, s3_key
           FROM tracks WHERE user_id=$1 AND id = ANY($2::uuid[])`,
          [userId, trackIds]
        )
        if (rows.length === 0) return reply.code(404).send({ error: 'no_tracks_found' })

        // Build zip and stream to S3
        const { stream, filename } = await buildExportZip(fmt, rows as TrackRow[])
        const exportKey = `${userId}/${crypto.randomUUID()}-${filename}`

        // Pipe to S3 (content length unknown — MinIO supports streaming)
        await s3.putObject(config.s3.bucketExports, exportKey, stream)

        const exp = await pool.query(
          `INSERT INTO exports (user_id, format, track_ids, s3_key, status)
           VALUES ($1,$2,$3,$4,'ready') RETURNING id, created_at`,
          [userId, fmt, trackIds, exportKey]
        )

        const downloadUrl = await presignGet(config.s3.bucketExports, exportKey, 3600)
        return { exportId: exp.rows[0].id, format: fmt, filename, downloadUrl }
      }
    )
  }
}
