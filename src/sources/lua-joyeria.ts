import * as cheerio from 'cheerio'
import { ORIGINAL_WATCHES_CATEGORY, sanitizeSourceDescription } from '../catalog-utils.js'
import type { CatalogProduct } from '../catalog-sync.js'

const DEFAULT_BASE = 'https://luajoyeriaccs.com'
const USER_AGENT = 'KRONOS-CatalogSync/1.0'

type WooStoreProduct = {
  id: number
  name: string
  slug: string
  sku?: string
  description?: string
  short_description?: string
  permalink?: string
  is_in_stock?: boolean
  stock_availability?: { text?: string, class?: string }
  prices?: {
    price?: string
    regular_price?: string
    sale_price?: string
    currency_minor_unit?: number
  }
  images?: Array<{ src?: string }>
  categories?: Array<{ name?: string, slug?: string }>
}

function stripHtml(value: string | undefined) {
  if (!value) return undefined
  const text = cheerio.load(value).root().text().replace(/\s+/g, ' ').trim()
  return text || undefined
}

function moneyFromMinor(value: string | undefined, minorUnit = 2) {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return undefined
  return raw / (10 ** minorUnit)
}

function brandFromCategories(categories: WooStoreProduct['categories']) {
  const ignored = new Set(['reloj', 'sin-categorizar', 'uncategorized'])
  const brand = (categories ?? []).find((category) => category.slug && !ignored.has(category.slug))
  return brand?.name?.trim() || undefined
}

export async function fetchLuaJoyeriaProducts(baseUrl = process.env.LUA_JOYERIA_URL ?? DEFAULT_BASE) {
  const root = baseUrl.replace(/\/$/, '')
  const products: CatalogProduct[] = []
  let page = 1
  let totalPages = 1

  while (page <= totalPages && page <= 50) {
    const url = `${root}/wp-json/wc/store/v1/products?per_page=50&page=${page}`
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Lua Joyería respondió ${response.status} en ${url}`)

    const totalHeader = Number(response.headers.get('x-wp-totalpages'))
    if (Number.isFinite(totalHeader) && totalHeader > 0) totalPages = totalHeader

    const batch = await response.json() as WooStoreProduct[]
    if (!Array.isArray(batch) || batch.length === 0) break

    for (const item of batch) {
      const minor = item.prices?.currency_minor_unit ?? 2
      const sourcePriceUsd = moneyFromMinor(item.prices?.sale_price || item.prices?.price || item.prices?.regular_price, minor)
      if (!item.name || !(sourcePriceUsd && sourcePriceUsd > 0)) continue

      const skuSeed = item.sku?.trim() || String(item.id)
      products.push({
        sku: `LUA-${skuSeed}`,
        name: item.name.trim(),
        description: sanitizeSourceDescription(stripHtml(item.description) || stripHtml(item.short_description)),
        sourcePriceUsd,
        category: ORIGINAL_WATCHES_CATEGORY,
        brand: brandFromCategories(item.categories),
        imageUrls: [...new Set((item.images ?? []).map((image) => image.src).filter((src): src is string => Boolean(src)))],
        available: item.is_in_stock === true && item.stock_availability?.class !== 'out-of-stock',
        sourceUrl: item.permalink || `${root}/p/${item.slug}/`,
      })
    }

    page += 1
  }

  return products
}
