import * as cheerio from 'cheerio'
import { ORIGINAL_WATCHES_CATEGORY } from '../catalog-utils.js'
import type { CatalogProduct } from '../catalog-sync.js'

const DEFAULT_BASE = 'https://www.ecko-joyas.com'
const USER_AGENT = 'KRONOS-CatalogSync/1.0 (+https://kronos-frontend-wikw.onrender.com)'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Parsea precios estilo VE: $7.800,00 → 7800 */
export function parseEckoPrice(value: string) {
  const cleaned = value
    .replace(/[^\d.,]/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.')
  const amount = Number(cleaned)
  return Number.isFinite(amount) && amount > 0 ? amount : undefined
}

function upgradeImageUrl(url: string) {
  return url.replace('/storage/products/thumbs/', '/storage/products/')
}

async function fetchHtml(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Ecko Joyas respondió ${response.status} en ${url}`)
  return response.text()
}

function parseListing(html: string, root: string) {
  const $ = cheerio.load(html)
  const found = new Map<string, { slug: string, name: string, price?: number, imageUrl?: string, href: string }>()

  $('a[href*="/tienda/"]').each((_index, element) => {
    const href = $(element).attr('href')
    if (!href) return
    let url: URL
    try {
      url = new URL(href, root)
    } catch {
      return
    }
    const match = url.pathname.match(/^\/tienda\/([a-z0-9-]+)$/i)
    if (!match) return
    const slug = match[1]
    if (['cart', 'login', 'cuenta', 'checkout'].includes(slug.toLowerCase())) return

    const card = $(element).closest('article, li, .product, .group, div')
    const name = (
      card.find('h2, h3').first().text()
      || $(element).text()
      || slug
    ).replace(/\s+/g, ' ').trim()
    const priceText = card.text().match(/\$\s*([\d.,]+)/)?.[1]
    const imageUrl = card.find('img').first().attr('src') || undefined
    const current = found.get(slug)
    found.set(slug, {
      slug,
      name: name || current?.name || slug,
      price: parseEckoPrice(priceText ?? '') ?? current?.price,
      imageUrl: imageUrl || current?.imageUrl,
      href: url.toString(),
    })
  })

  return [...found.values()]
}

async function enrichFromDetail(product: { slug: string, name: string, price?: number, imageUrl?: string, href: string }, root: string) {
  const html = await fetchHtml(product.href)
  const $ = cheerio.load(html)
  const name = $('h1').first().text().replace(/\s+/g, ' ').trim() || product.name
  const priceText = $('h1').first().parent().parent().find('p').filter((_i, el) => /\$/.test($(el).text())).first().text()
    || $('main').text().match(/\$\s*([\d.,]+)/)?.[0]
    || ''
  const price = parseEckoPrice(priceText) ?? product.price
  const images: string[] = []
  const pushImage = (src?: string) => {
    if (!src) return
    const upgraded = upgradeImageUrl(src)
    if (!images.includes(upgraded)) images.push(upgraded)
  }
  // Solo la galería cercana al H1 (evita fotos de productos relacionados más abajo).
  const heroRoot = $('h1').first().closest('div').parent()
  heroRoot.find('img[src*="/storage/products/"]').each((_i, el) => {
    if (images.length >= 4) return false
    pushImage($(el).attr('src'))
    return undefined
  })
  if (images.length === 0) pushImage($('img[src*="/storage/products/"]').first().attr('src'))
  pushImage(product.imageUrl)

  const description = $('meta[name="description"]').attr('content')?.trim()
    || $('main p').filter((_i, el) => $(el).text().trim().length > 40).first().text().replace(/\s+/g, ' ').trim()
    || undefined

  return {
    sku: `ECKO-${product.slug}`,
    name,
    description,
    sourcePriceUsd: price,
    category: ORIGINAL_WATCHES_CATEGORY,
    brand: undefined as string | undefined,
    imageUrls: images.slice(0, 4),
    available: true,
    sourceUrl: product.href.startsWith('http') ? product.href : `${root}/tienda/${product.slug}`,
  } satisfies CatalogProduct
}

export async function fetchEckoJoyasProducts(baseUrl = process.env.ECKO_JOYAS_URL ?? DEFAULT_BASE) {
  const root = baseUrl.replace(/\/$/, '')
  const listed = new Map<string, { slug: string, name: string, price?: number, imageUrl?: string, href: string }>()

  for (let page = 1; page <= 10; page += 1) {
    const url = page === 1 ? `${root}/tienda` : `${root}/tienda?page=${page}`
    const html = await fetchHtml(url)
    const batch = parseListing(html, root)
    if (batch.length === 0) break
    for (const item of batch) listed.set(item.slug, item)
    const hasNext = html.includes(`tienda?page=${page + 1}`) || html.includes(`page=${page + 1}`)
    if (!hasNext && batch.length < 12) break
    await sleep(350)
  }

  const products: CatalogProduct[] = []
  for (const item of listed.values()) {
    try {
      const enriched = await enrichFromDetail(item, root)
      if (!enriched.sourcePriceUsd || !(enriched.sourcePriceUsd > 0)) {
        console.warn(`Ecko: sin precio válido para ${item.slug}`)
        continue
      }
      products.push(enriched)
    } catch (error) {
      console.warn(`Ecko: no se pudo leer ficha ${item.slug}:`, error)
      if (item.price) {
        products.push({
          sku: `ECKO-${item.slug}`,
          name: item.name,
          sourcePriceUsd: item.price,
          category: ORIGINAL_WATCHES_CATEGORY,
          imageUrls: item.imageUrl ? [upgradeImageUrl(item.imageUrl)] : [],
          available: true,
          sourceUrl: item.href,
        })
      }
    }
    await sleep(350)
  }

  return products
}
