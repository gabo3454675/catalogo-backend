import { lookup as dnsLookup } from 'node:dns'
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import { Agent, fetch } from 'undici'

const allowedImageHosts = new Set(['xproservidor.com', 'www.milcatalogos.com'])
const allowedImageTypes = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const maxRedirects = 3

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export const remoteImageLimits = {
  maxBytes: positiveInteger(process.env.REMOTE_IMAGE_MAX_BYTES, 8 * 1024 * 1024),
  timeoutMs: positiveInteger(process.env.REMOTE_IMAGE_TIMEOUT_MS, 10_000),
}

function isPrivateIpv4(address: string) {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const [a, b, c] = octets
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
}

export function isPrivateIp(address: string) {
  const normalized = address.toLowerCase().split('%')[0]
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized)
  if (isIP(normalized) !== 6) return true
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true
  if (normalized.startsWith('fec') || normalized.startsWith('fed') || normalized.startsWith('fee') || normalized.startsWith('fef')) return true
  if (normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return true
  if (normalized.startsWith('::ffff:')) return true
  return false
}

export function validateRemoteImageUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('URL de imagen no válida')
  }
  if (url.protocol !== 'https:') throw new Error('La imagen remota debe usar HTTPS')
  if (url.username || url.password) throw new Error('La URL de imagen no puede contener credenciales')
  if (url.port && url.port !== '443') throw new Error('El puerto de la imagen remota no está permitido')
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!allowedImageHosts.has(hostname)) throw new Error('Host de imagen no permitido')
  if (isIP(hostname)) throw new Error('Las direcciones IP no están permitidas como origen')
  return url
}

function validateAddresses(addresses: LookupAddress[]) {
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error('El host de imagen resolvió a una dirección no permitida')
  }
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...(typeof options === 'object' ? options : {}), all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 4)
      return
    }
    try {
      validateAddresses(addresses)
      if (typeof options === 'object' && (options as LookupAllOptions).all) {
        ;(callback as (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, addresses)
        return
      }
      const requestedFamily = typeof options === 'object' ? (options as LookupOneOptions).family : undefined
      const selected = addresses.find(({ family }) => !requestedFamily || family === requestedFamily) ?? addresses[0]
      callback(null, selected.address, selected.family)
    } catch (error) {
      callback(error as NodeJS.ErrnoException, '', 4)
    }
  })
}

const safeDispatcher = new Agent({
  connect: {
    lookup: safeLookup,
    timeout: remoteImageLimits.timeoutMs,
  },
  headersTimeout: remoteImageLimits.timeoutMs,
  bodyTimeout: remoteImageLimits.timeoutMs,
})

function imageContentType(value: string | null) {
  const contentType = value?.split(';', 1)[0].trim().toLowerCase()
  if (!contentType || !allowedImageTypes.has(contentType)) throw new Error('El origen no devolvió un tipo de imagen permitido')
  return contentType
}

async function readLimitedBody(response: Response) {
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > remoteImageLimits.maxBytes) {
    throw new Error('La imagen remota supera el tamaño máximo permitido')
  }
  if (!response.body) throw new Error('La imagen remota no contiene datos')

  const chunks: Uint8Array[] = []
  let received = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > remoteImageLimits.maxBytes) throw new Error('La imagen remota supera el tamaño máximo permitido')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks, received)
}

export async function downloadRemoteImage(sourceUrl: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remoteImageLimits.timeoutMs)
  let currentUrl = validateRemoteImageUrl(sourceUrl)
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const response = await fetch(currentUrl, {
        dispatcher: safeDispatcher,
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || redirects === maxRedirects) throw new Error('Redirección de imagen no permitida')
        currentUrl = validateRemoteImageUrl(new URL(location, currentUrl).toString())
        continue
      }
      if (!response.ok) throw new Error(`No se pudo descargar la imagen: ${response.status}`)
      const contentType = imageContentType(response.headers.get('content-type'))
      return { body: await readLimitedBody(response as unknown as Response), contentType }
    }
    throw new Error('Demasiadas redirecciones al descargar la imagen')
  } catch (error) {
    if (controller.signal.aborted) throw new Error('La descarga de la imagen excedió el tiempo límite')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
