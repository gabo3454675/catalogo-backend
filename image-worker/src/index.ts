export interface Env {
  IMAGES: R2Bucket
  UPLOAD_TOKEN: string
  RENDER_API_URL: string
  CATALOG_SYNC_SECRET: string
}

const imageKey = (pathname: string) => pathname.slice(1).startsWith('products/') && !pathname.includes('..')
const catalogUrl = 'https://www.milcatalogos.com/volkovamen/catalogo'
const productsUrl = 'https://xproservidor.com/catalogoassets/control/masProductos.php'
const sourceHeaders = { 'User-Agent': 'Mozilla/5.0', Referer: catalogUrl, Origin: 'https://www.milcatalogos.com', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-VE,es;q=0.9' }
const batchSize = 50

type CatalogProduct = {
  sku: string
  name: string
  description?: string
  sourcePriceBs: number
  category: string
  brand?: string
  imageUrls: string[]
  available: boolean
  sourceUrl: string
}

type ProductPage = {
  respuestaOK: boolean
  productos?: string
  resultadoBusqueda?: string | number
  categoriaActual?: number
}

const slugify = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

function readAttributes(tag: string) {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w-]+)=(["'])(.*?)\2/g)) attributes[match[1]] = match[3]
  return attributes
}

function priceInBolivars(value: string | undefined) {
  const parsed = Number((value ?? '').replace(/[.,](?=\d{3}(?:[.,]|$))/g, '').replace(',', '.'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function absoluteImageUrl(value: string) {
  try {
    return new URL(value, catalogUrl).toString()
  } catch {
    return undefined
  }
}

function parseProducts(html: string): CatalogProduct[] {
  const products = new Map<string, CatalogProduct>()
  for (const tagMatch of html.matchAll(/<[^>]*class=(["'])[^"']*\bcontenidoItem\b[^"']*\1[^>]*>/gi)) {
    const attributes = readAttributes(tagMatch[0])
    const name = attributes.modalTituloProducto?.trim()
    const sourcePriceBs = priceInBolivars(attributes.modalPrecioCarrito)
    if (!name || !sourcePriceBs) continue

    const imageUrls = [1, 2, 3, 4, 5]
      .map((index) => attributes[`modalImagenGaleria${index}`]?.trim())
      .filter((image): image is string => Boolean(image))
      .map(absoluteImageUrl)
      .filter((image): image is string => Boolean(image))
    const sku = attributes.modalIdProducto?.trim() || slugify(name)
    products.set(sku, {
      sku,
      name,
      description: attributes.modalDescripcionProducto?.trim() || undefined,
      sourcePriceBs,
      category: attributes.modalCategoriaProducto?.trim() || 'General',
      brand: attributes.modalMarcaProducto?.trim() || undefined,
      imageUrls: [...new Set(imageUrls)],
      available: attributes.modalStock !== '0',
      sourceUrl: catalogUrl,
    })
  }
  return [...products.values()]
}

async function getDataFilters() {
  const response = await fetch(catalogUrl, { headers: sourceHeaders })
  if (!response.ok) throw new Error(`VOLKOVAMEN respondió ${response.status} al solicitar el catálogo.`)
  const html = await response.text()
  const match = html.match(/id=(["'])dataFiltros\1[^>]*\bdataFiltros=(["'])(.*?)\2/i)
    ?? html.match(/\bdataFiltros=(["'])(.*?)\1/i)
  const dataFilters = match?.[3] ?? match?.[2]
  if (!dataFilters) throw new Error('VOLKOVAMEN no entregó dataFiltros.')
  return dataFilters
}

async function fetchCatalogProducts() {
  const dataFiltros = await getDataFilters()
  const products = new Map<string, CatalogProduct>()
  let page = 0
  let firstLoad = 1
  let category = 0

  while (page < 100) {
    const body = new URLSearchParams({
      dataFiltros,
      categoriaActual: String(category),
      paginacionActual: String(page),
      primeraCargaProducto: String(firstLoad),
    })
    const response = await fetch(productsUrl, {
      method: 'POST',
      headers: { ...sourceHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!response.ok) throw new Error(`VOLKOVAMEN respondió ${response.status} en la página ${page}.`)
    const data = await response.json() as ProductPage | string
    const result = typeof data === 'string' ? JSON.parse(data) as ProductPage : data
    if (!result.respuestaOK) throw new Error(`VOLKOVAMEN rechazó la página ${page}.`)
    const parsed = parseProducts(result.productos ?? '')
    for (const product of parsed) products.set(product.sku, product)
    if (parsed.length === 0 || result.resultadoBusqueda === 'fin-busqueda' || result.resultadoBusqueda === 'no-resultado') break
    page += 1
    firstLoad = 0
    category = result.categoriaActual ?? category
  }
  if (products.size === 0) throw new Error('VOLKOVAMEN no devolvió productos.')
  return [...products.values()]
}

function renderEndpoint(env: Env, suffix = '') {
  return `${env.RENDER_API_URL.replace(/\/$/, '')}/api/v1/internal/catalog-sync${suffix}`
}

async function sendBatches(env: Env, products: CatalogProduct[], onRunId: (runId: string) => void) {
  let runId: string | undefined
  for (let index = 0; index < products.length; index += batchSize) {
    const batch = products.slice(index, index + batchSize)
    const response = await fetch(renderEndpoint(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kronos-Sync-Token': env.CATALOG_SYNC_SECRET },
      body: JSON.stringify({ runId, products: batch, complete: index + batchSize >= products.length }),
    })
    if (!response.ok) throw new Error(`Render rechazó el lote ${index / batchSize + 1}: ${response.status}.`)
    const data = await response.json() as { runId: string }
    runId = data.runId
    onRunId(runId)
  }
  return runId
}

async function synchronizeCatalog(env: Env) {
  let runId: string | undefined
  try {
    const products = await fetchCatalogProducts()
    runId = await sendBatches(env, products, (receivedRunId) => { runId = receivedRunId })
    console.log(`Sincronización completada: ${products.length} productos, ejecución ${runId}.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'
    console.error('La sincronización falló:', message)
    if (runId) {
      await fetch(renderEndpoint(env, '/fail'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kronos-Sync-Token': env.CATALOG_SYNC_SECRET },
        body: JSON.stringify({ runId, error: message }),
      })
    }
    throw error
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/sync/trigger' && request.method === 'POST') {
      if (request.headers.get('X-Kronos-Token') !== env.UPLOAD_TOKEN) return new Response('Unauthorized', { status: 401 })
      await synchronizeCatalog(env)
      return Response.json({ status: 'started' })
    }

    const key = decodeURIComponent(url.pathname.slice(1))
    if (!imageKey(`/${key}`)) return new Response('Not found', { status: 404 })

    if (request.method === 'GET' || request.method === 'HEAD') {
      const object = await env.IMAGES.get(key)
      if (!object) return new Response('Not found', { status: 404 })
      const headers = new Headers()
      object.writeHttpMetadata(headers)
      headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      headers.set('ETag', object.httpEtag)
      return new Response(request.method === 'HEAD' ? null : object.body, { headers })
    }

    if (request.method === 'PUT') {
      if (request.headers.get('X-Kronos-Token') !== env.UPLOAD_TOKEN) return new Response('Unauthorized', { status: 401 })
      if (!request.body || !request.headers.get('Content-Type')?.startsWith('image/')) return new Response('Invalid image', { status: 400 })
      await env.IMAGES.put(key, request.body, { httpMetadata: { contentType: request.headers.get('Content-Type') } })
      return Response.json({ key, url: new URL(request.url).toString() })
    }

    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, PUT' } })
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(synchronizeCatalog(env))
  },
} satisfies ExportedHandler<Env>
