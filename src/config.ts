import 'dotenv/config'

export const config = {
  port: Number(process.env.PORT || 7781),
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-prod-please',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'wavdrop',
    password: process.env.DB_PASSWORD || 'wavdrop_dev_2026',
    database: process.env.DB_NAME || 'wavdrop',
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT || '127.0.0.1',
    port: Number(process.env.S3_PORT || 9000),
    useSSL: process.env.S3_USE_SSL === 'true',
    accessKey: process.env.S3_ACCESS_KEY || 'wavdrop_minio',
    secretKey: process.env.S3_SECRET_KEY || 'wavdrop_minio_secret_2026',
    bucketTracks: 'wavdrop-tracks',
    bucketStems: 'wavdrop-stems',
    bucketExports: 'wavdrop-exports',
  },
  uploadDir: process.env.UPLOAD_DIR || '/opt/wavdrop-server/uploads',
  exportDir: process.env.EXPORT_DIR || '/opt/wavdrop-server/exports',
  maxUploadBytes: 500 * 1024 * 1024, // 500 MB per WAV
}
