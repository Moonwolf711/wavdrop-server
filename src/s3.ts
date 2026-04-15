import { Client } from 'minio'
import { config } from './config.js'

export const s3 = new Client({
  endPoint: config.s3.endpoint,
  port: config.s3.port,
  useSSL: config.s3.useSSL,
  accessKey: config.s3.accessKey,
  secretKey: config.s3.secretKey,
})

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
  return s3.presignedGetObject(bucket, key, expirySeconds)
}
