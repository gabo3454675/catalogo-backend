import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const endpoint = process.env.R2_ENDPOINT
const accessKeyId = process.env.R2_ACCESS_KEY_ID
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
const bucket = process.env.R2_BUCKET
const publicUrl = process.env.R2_PUBLIC_URL?.replace(/\/$/, '')

function client() {
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) {
    throw new Error('Faltan las variables de Cloudflare R2')
  }
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  })
}

export async function uploadRemoteImage(sourceUrl: string, objectKey: string) {
  const response = await fetch(sourceUrl)
  if (!response.ok) throw new Error(`No se pudo descargar la imagen: ${response.status}`)
  const body = await response.arrayBuffer()
  const contentType = response.headers.get('content-type') ?? 'image/jpeg'
  await client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: new Uint8Array(body),
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return `${publicUrl}/${objectKey}`
}
