import 'dotenv/config'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { prisma } from '../prisma.js'
import { uploadRemoteImage } from '../r2.js'

const SOURCE_URL = process.env.CATALOG_SOURCE_URL ?? 'https://www.milcatalogos.com/volkovamen/catalogo'
const PRODUCT_API_URL = process.env.CATALOG_PRODUCTS_URL ?? 'https://xproservidor.com/catalogoassets/control/masProductos.php'
const RATE_URL = process.env.BCV_RATE_URL ?? 'https://ve.dolarapi.com/v1/euros/oficial'
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
  imageUrl: string | undefined
  available: boolean
}

type BcvRate = { value: number, updatedAt: Date }

function parseProducts(html: string): SourceProduct[] {
  const $ = cheerio.load(html)
  return $('.contenidoItem').map((_index, element) => {
    const item = $(element)
    const card = item.closest('.cajaItem')
    const sourcePriceBs = Number((item.attr('modalPrecioCarrito') ?? '').replace(',', '.'))
    const name = item.attr('modalTituloProducto')?.trim() ?? ''
    const sourceImage = card.find('img[data-src]').first().attr('data-src')
    if (!name || !Number.isFinite(sourcePriceBs)) return null
    return {
      sku: item.attr('modalIdProducto') ?? slugify(name),
      name,
      description: item.attr('modalDescripcionProducto')?.trim() || undefined,
      sourcePriceBs,
      category: card.find('.tt-add-info li').first().text().trim() || 'General',
      brand: card.find('.tt-add-info li').first().text().trim() || undefined,
      imageUrl: sourceImage,
      available: item.attr('modalStock') !== '0',
    }
  }).get().filter((product): product is SourceProduct => product !== null)
}

async function fetchSourceProducts() {
  const { data: sourceHtml } = await axios.get<string>(SOURCE_URL, { headers })
  const $ = cheerio.load(sourceHtml)
  const dataFiltros = $('#dataFiltros').attr('dataFiltros')
  if (!dataFiltros) throw new Error('VOLKOVAMEN no entregó el identificador de filtros requerido para sincronizar.')

  const products = new Map<string, SourceProduct>()
  let page = 0
  let firstLoad = 1
  let category = 0
  while (page < 100) {
    const { data } = await axios.post<{ respuestaOK: boolean, productos: string, resultadoBusqueda: string, categoriaActual: number }>(
      PRODUCT_API_URL,
      new URLSearchParams({ dataFiltros, categoriaActual: String(category), paginacionActual: String(page), primeraCargaProducto: String(firstLoad) }),
      { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } },
    )
    if (!data.respuestaOK) throw new Error('VOLKOVAMEN rechazó la consulta de productos.')
    for (const product of parseProducts(data.productos)) products.set(product.sku, product)
    if (data.resultadoBusqueda === 'fin-busqueda' || data.resultadoBusqueda === 'no-resultado') break
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
  const markupUsd = isWatch ? (commercialUsd >= 100 ? 15 : 10) : 0
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
      const existing = await prisma.product.findUnique({ where: { slug } })
      const category = await prisma.category.upsert({ where: { slug: slugify(product.category) }, update: { name: product.category }, create: { name: product.category, slug: slugify(product.category) } })
      const brand = product.brand ? await prisma.brand.upsert({ where: { slug: slugify(product.brand) }, update: { name: product.brand }, create: { name: product.brand, slug: slugify(product.brand) } }) : undefined
      const { price, markupUsd } = sellingPrice(product, rate.value)
      const imageUrl = existing?.imageUrl ?? (product.imageUrl ? await uploadRemoteImage(product.imageUrl, `products/${slug}.jpg`) : undefined)
      await prisma.product.upsert({
        where: { slug },
        update: { sku: product.sku, name: product.name, description: product.description, price, sourcePriceBs: product.sourcePriceBs, exchangeRate: rate.value, markupUsd, available: product.available, sourceUrl: SOURCE_URL, imageUrl, categoryId: category.id, brandId: brand?.id },
        create: { sku: product.sku, slug, name: product.name, description: product.description, price, sourcePriceBs: product.sourcePriceBs, exchangeRate: rate.value, markupUsd, available: product.available, sourceUrl: SOURCE_URL, imageUrl, categoryId: category.id, brandId: brand?.id },
      })
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
