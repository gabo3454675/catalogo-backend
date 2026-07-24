import 'dotenv/config'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { prisma } from '../prisma.js'
import { uploadRemoteImage } from '../r2.js'

const SOURCE_URL = process.env.CATALOG_SOURCE_URL ?? 'https://www.milcatalogos.com/volkovamen/catalogo'
const PRODUCT_API_URL = process.env.CATALOG_PRODUCTS_URL ?? 'https://xproservidor.com/catalogoassets/control/masProductos.php'
const RATE_URL = process.env.BCV_RATE_URL ?? 'https://ve.dolarapi.com/v1/euros/oficial'
const catalogProxyUrl = (process.env.CATALOG_PROXY_URL ?? process.env.MEDIA_WORKER_URL)?.replace(/\/$/, '')
const uploadToken = process.env.MEDIA_UPLOAD_TOKEN
const headers = { 'User-Agent': 'Mozilla/5.0', Referer: SOURCE_URL, Origin: 'https://www.milcatalogos.com', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-VE,es;q=0.9' }

const slugify = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
const roundUsd = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

type SourceProduct = {
  sku: string
  name: string
  description: string | undefined
  sourcePriceBs: number
  category: string
  brand: string | undefined
  imageUrls: string[]
  available: boolean
}

type BcvRate = { value: number, updatedAt: Date }

function parseProducts(html: string): SourceProduct[] {
  const $ = cheerio.load(html)
  return $('.contenidoItem').map((_index, element) => {
    const item = $(element)
    const card = item.closest('.cajaItem')
    const sourcePriceBs = Number((item.attr('modalPrecioCarrito') ?? '').replace(/[.,](?=\d{3}(?:[.,]|$))/g, '').replace(',', '.'))
    const name = item.attr('modalTituloProducto')?.trim() ?? ''
    const sourceImage = card.find('img[data-src]').first().attr('data-src')
    const imageBase = sourceImage ? new URL('./', sourceImage).toString() : undefined
    const imageUrls = [1, 2, 3, 4, 5]
      .map((index) => item.attr(`modalImagenGaleria${index}`)?.trim())
      .filter((filename): filename is string => Boolean(filename))
      .map((filename) => imageBase ? new URL(filename, imageBase).toString() : undefined)
      .filter((url): url is string => Boolean(url))
    if (sourceImage && !imageUrls.includes(sourceImage)) imageUrls.unshift(sourceImage)
    if (!name || !Number.isFinite(sourcePriceBs)) return null
    return {
      sku: item.attr('modalIdProducto') ?? slugify(name),
      name,
      description: item.attr('modalDescripcionProducto')?.trim() || undefined,
      sourcePriceBs,
      category: card.find('.tt-add-info li').first().text().trim() || 'General',
      brand: card.find('.tt-add-info li').first().text().trim() || undefined,
      imageUrls: [...new Set(imageUrls)],
      available: item.attr('modalStock') !== '0',
    }
  }).get().filter((product): product is SourceProduct => product !== null)
}

async function fetchSourceProducts() {
  if (catalogProxyUrl && !uploadToken) throw new Error('MEDIA_UPLOAD_TOKEN es obligatoria cuando se usa el proxy de catálogo.')
  const proxyHeaders = catalogProxyUrl && uploadToken ? { 'X-Kronos-Token': uploadToken } : undefined
  const configuredFilters = process.env.CATALOG_DATA_FILTERS?.trim()
  let dataFiltros = configuredFilters
  if (!dataFiltros) {
    const { data: sourceHtml } = catalogProxyUrl
      ? await axios.get<string>(`${catalogProxyUrl}/sync/catalog`, { headers: proxyHeaders })
      : await axios.get<string>(SOURCE_URL, { headers })
    dataFiltros = cheerio.load(sourceHtml)('#dataFiltros').attr('dataFiltros')
  }
  if (!dataFiltros) throw new Error('VOLKOVAMEN no entregó el identificador de filtros requerido para sincronizar.')

  const products = new Map<string, SourceProduct>()
  let page = 0
  let firstLoad = 1
  let category = 0
  while (page < 100) {
    const formData = new URLSearchParams({ dataFiltros, categoriaActual: String(category), paginacionActual: String(page), primeraCargaProducto: String(firstLoad) })
    const response = catalogProxyUrl
      ? await axios.post<{ respuestaOK: boolean, productos: string, resultadoBusqueda: string | number, categoriaActual: number }>(`${catalogProxyUrl}/sync/products`, formData.toString(), { headers: { ...proxyHeaders, 'Content-Type': 'application/x-www-form-urlencoded' } })
      : await axios.post<{ respuestaOK: boolean, productos: string, resultadoBusqueda: string | number, categoriaActual: number }>(PRODUCT_API_URL, formData, { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } })
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    if (!data.respuestaOK) throw new Error('VOLKOVAMEN rechazó la consulta de productos.')
    const parsedProducts = parseProducts(data.productos ?? '')
    console.log(`Página ${page}: ${parsedProducts.length} productos procesados (${String(data.resultadoBusqueda)}).`)
    for (const product of parsedProducts) products.set(product.sku, product)
    if (parsedProducts.length === 0 || data.resultadoBusqueda === 'fin-busqueda' || data.resultadoBusqueda === 'no-resultado') break
    page += 1
    firstLoad = 0
    category = data.categoriaActual
  }
  return [...products.values()]
}

function findRate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['promedio', 'venta', 'compra', 'rate', 'mid', 'tasa', 'value', 'usd']) {
    const found = findRate(record[key])
    if (found) return found
  }
  return undefined
}

async function fetchBcvRate(): Promise<BcvRate> {
  const { data } = await axios.get(RATE_URL, { headers: { Accept: 'application/json' } })
  const value = findRate(data)
  const timestamp = (data as Record<string, unknown>).fechaActualizacion ?? (data as Record<string, unknown>).updated_at ?? (data as Record<string, unknown>).updatedAt
  if (!value || value <= 0) throw new Error('DolarAPI no entregó una tasa EUR/VES válida.')
  return { value, updatedAt: timestamp ? new Date(String(timestamp)) : new Date() }
}

function sellingPrice(product: SourceProduct, rate: number) {
  // Regla comercial solicitada: la tasa oficial EUR/VES define el valor base mostrado en USD.
  const commercialUsd = product.sourcePriceBs / rate
  const isWatch = /reloj/i.test(product.category) || /reloj/i.test(product.name)
  const markupUsd = isWatch
    ? commercialUsd >= 40 ? 20 : commercialUsd >= 30 ? 15 : 10
    : commercialUsd >= 100 ? 15 : 10
  return { price: roundUsd(commercialUsd + markupUsd), markupUsd }
}

export async function syncCatalog() {
  const syncRun = await prisma.syncRun.create({ data: { status: 'running' } })
  try {
    const [products, rate] = await Promise.all([fetchSourceProducts(), fetchBcvRate()])
    if (products.length === 0) throw new Error('VOLKOVAMEN no devolvió productos durante esta sincronización.')
    let productsAdded = 0
    for (const product of products) {
      const slug = `${slugify(product.name)}-${product.sku}`
      const existing = await prisma.product.findUnique({ where: { slug }, include: { images: { orderBy: { sortOrder: 'asc' } } } })
      const category = await prisma.category.upsert({ where: { slug: slugify(product.category) }, update: { name: product.category }, create: { name: product.category, slug: slugify(product.category) } })
      const brand = product.brand ? await prisma.brand.upsert({ where: { slug: slugify(product.brand) }, update: { name: product.brand }, create: { name: product.brand, slug: slugify(product.brand) } }) : undefined
      const { price, markupUsd } = sellingPrice(product, rate.value)
      const savedProduct = await prisma.product.upsert({
        where: { slug },
        update: { sku: product.sku, name: product.name, description: product.description, price, sourcePriceBs: product.sourcePriceBs, exchangeRate: rate.value, markupUsd, available: product.available, sourceUrl: SOURCE_URL, categoryId: category.id, brandId: brand?.id },
        create: { sku: product.sku, slug, name: product.name, description: product.description, price, sourcePriceBs: product.sourcePriceBs, exchangeRate: rate.value, markupUsd, available: product.available, sourceUrl: SOURCE_URL, categoryId: category.id, brandId: brand?.id },
      })
      let coverImageUrl = existing?.images[0]?.url ?? savedProduct.imageUrl
      for (const [sortOrder, sourceImageUrl] of product.imageUrls.entries()) {
        const storedImage = existing?.images.find((image) => image.sortOrder === sortOrder)
        if (storedImage) {
          if (sortOrder === 0) coverImageUrl = storedImage.url
          continue
        }
        try {
          const imageUrl = await uploadRemoteImage(sourceImageUrl, `products/${slug}/${sortOrder}.jpg`)
          await prisma.productImage.upsert({
            where: { productId_sortOrder: { productId: savedProduct.id, sortOrder } },
            update: { url: imageUrl },
            create: { productId: savedProduct.id, sortOrder, url: imageUrl },
          })
          if (sortOrder === 0) coverImageUrl = imageUrl
        } catch (error) {
          console.warn(`No se pudo importar imagen ${sortOrder + 1} de ${product.sku}:`, error)
        }
      }
      if (coverImageUrl && coverImageUrl !== savedProduct.imageUrl) {
        await prisma.product.update({ where: { id: savedProduct.id }, data: { imageUrl: coverImageUrl } })
      }
      if (!existing) productsAdded += 1
    }
    await prisma.syncRun.update({ where: { id: syncRun.id }, data: { status: 'success', completedAt: new Date(), productsFound: products.length, productsAdded, exchangeRate: rate.value, rateUpdatedAt: rate.updatedAt } })
    return { productsFound: products.length, productsAdded }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'
    await prisma.syncRun.update({ where: { id: syncRun.id }, data: { status: 'failed', completedAt: new Date(), error: message } })
    throw error
  }
}

syncCatalog().then(({ productsFound, productsAdded }) => console.log(`Sincronización completa: ${productsFound} encontrados, ${productsAdded} nuevos.`)).catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => prisma.$disconnect())
