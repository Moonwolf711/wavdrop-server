import { Client } from 'minio'
import { config } from './config.js'

/**
 * Two clients:
 *  - internal: talks to MinIO on loopback (fast uploads/downloads)
 *  - public: same creds but with the public hostname so presigned URLs
 *    generated with it are reachable from clients outside the VPS.
 */
export const s3 = new Client({
  endPoint: config.s3.endpoint,
  port: config.s3.port,
  useSSL: config.s3.useSSL,
  accessKey: config.s3.accessKey,
  secretKey: config.s3.secretKey,
  pathStyle: true,
})

const publicHost = process.env.S3_PUBLIC_HOST || 'wavdrop.76.13.127.240.sslip.io'
const publicPort = Number(process.env.S3_PUBLIC_PORT || 443)
const publicSSL = (process.env.S3_PUBLIC_SSL ?? 'true') === 'true'
const publicPath = process.env.S3_PUBLIC_PATH || '/minio'

export const s3Public = new Client({
  endPoint: publicHost,
  port: publicPort,
  useSSL: publicSSL,
  accessKey: config.s3.accessKey,
  secretKey: config.s3.secretKey,
  pathStyle: true,
  region: 'us-east-1',
  // Virtual-host style won't work through path prefix — keep pathStyle.
})

// Monkey-patch: minio-js does not expose a way to prepend a path prefix
// to presigned URLs. Post-process the returned URL instead.
function rewriteToPublic(url: string): string {
  if (!publicPath) return url
  // minio-js presigns like https://host/bucket/key?... — we need /minio/bucket/key?...
  const u = new URL(url)
  u.pathname = `${publicPath}${u.pathname}`
  return u.toString()
}

export async function ensureBuckets() {
  for (const bucket of [
    config.s3.bucketTracks,
    config.s3.bucketStems,
    config.s3.bucketExports,
  ]) {
    const exists = await s3.bucketExists(bucket).catch(() => false)
    if (!exists) await s3.makeBucket(bucket, 'us-east-1')
  }
}

export async function putObject(bucket: string, key: string, body: Buffer | NodeJS.ReadableStream, size?: number) {
  return s3.putObject(bucket, key, body as any, size)
}

export async function presignGet(bucket: string, key: string, expirySeconds = 3600) {
  const raw = await s3Public.presignedGetObject(bucket, key, expirySeconds)
  return rewriteToPublic(raw)
}
