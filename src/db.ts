import { Pool } from 'pg'
import { config } from './config.js'

export const pool = new Pool(config.db)

export async function initSchema() {
  const sql = `
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    apple_sub TEXT UNIQUE,
    google_sub TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    genre TEXT,
    bpm REAL,
    musical_key TEXT,
    duration_s REAL,
    sample_rate INT,
    bit_depth INT,
    file_size_bytes BIGINT,
    s3_key TEXT NOT NULL,
    sha256 TEXT,
    analyzed BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_tracks_user ON tracks(user_id);

  CREATE TABLE IF NOT EXISTS stem_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',
    model TEXT DEFAULT 'demucs',
    progress REAL DEFAULT 0,
    error TEXT,
    result_s3_prefix TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    format TEXT NOT NULL,
    track_ids UUID[] NOT NULL,
    s3_key TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ DEFAULT now(),
    ended_at TIMESTAMPTZ,
    avg_bpm REAL,
    transitions JSONB DEFAULT '[]'::jsonb,
    track_ids UUID[] DEFAULT '{}'::uuid[]
  );

  CREATE TABLE IF NOT EXISTS battles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS battle_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    round INT NOT NULL,
    score INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  `
  await pool.query(sql)
}
