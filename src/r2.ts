import { downloadRemoteImage } from './remote-image.js'

const mediaWorkerUrl = process.env.MEDIA_WORKER_URL?.replace(/\/$/, '')
const mediaUploadToken = process.env.MEDIA_UPLOAD_TOKEN

export async function uploadRemoteImage(sourceUrl: string, objectKey: string) {
  if (!mediaWorkerUrl || !mediaUploadToken) throw new Error('Faltan las variables del proxy de imágenes de Cloudflare')
  const source = await downloadRemoteImage(sourceUrl)
  const target = `${mediaWorkerUrl}/${objectKey}`
  const uploaded = await fetch(target, {
    method: 'PUT',
    headers: { 'X-Kronos-Token': mediaUploadToken, 'Content-Type': source.contentType },
    body: source.body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!uploaded.ok) throw new Error(`No se pudo guardar la imagen en R2: ${uploaded.status}`)
  return target
}
