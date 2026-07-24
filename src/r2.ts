const mediaWorkerUrl = process.env.MEDIA_WORKER_URL?.replace(/\/$/, '')
const mediaUploadToken = process.env.MEDIA_UPLOAD_TOKEN

export async function uploadRemoteImage(sourceUrl: string, objectKey: string) {
  if (!mediaWorkerUrl || !mediaUploadToken) throw new Error('Faltan las variables del proxy de imágenes de Cloudflare')
  const source = await fetch(sourceUrl)
  if (!source.ok) throw new Error(`No se pudo descargar la imagen: ${source.status}`)
  const contentType = source.headers.get('content-type') ?? 'image/jpeg'
  const target = `${mediaWorkerUrl}/${objectKey}`
  const uploaded = await fetch(target, {
    method: 'PUT',
    headers: { 'X-Kronos-Token': mediaUploadToken, 'Content-Type': contentType },
    body: await source.arrayBuffer(),
  })
  if (!uploaded.ok) throw new Error(`No se pudo guardar la imagen en R2: ${uploaded.status}`)
  return target
}
