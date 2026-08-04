import * as cheerio from 'cheerio'
import { ORIGINAL_WATCHES_CATEGORY, sanitizeSourceDescription } from '../catalog-utils.js'
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

type ListedProduct = {
  slug: string
  name: string
  price?: number
  imageUrl?: string
  brand?: string
  href: string
  /** Si el listado marca agotado explícitamente. */
  available: boolean
}

/**
 * Las fichas de detalle de Ecko NO incluyen la imagen principal del producto:
 * solo muestran "Productos relacionados". La foto correcta vive en el listado /tienda.
 */
export function parseListing(html: string, root: string): ListedProduct[] {
  const $ = cheerio.load(html)
  const found = new Map<string, ListedProduct>()

  $('img[src*="/storage/products/"]').each((_index, element) => {
    const img = $(element)
    const imageUrl = img.attr('src') || undefined
    const card = img.closest('div.bg-white, div.group, article, li')
    if (!card.length) return

    const link = card.find('a[href*="/tienda/"]').filter((_i, el) => {
      try {
        const pathname = new URL($(el).attr('href') || '', root).pathname
        return /^\/tienda\/[a-z0-9-]+$/i.test(pathname)
      } catch {
        return false
      }
    }).first()

    const hrefAttr = link.attr('href')
    if (!hrefAttr) return

    let url: URL
    try {
      url = new URL(hrefAttr, root)
    } catch {
      return
    }
    const match = url.pathname.match(/^\/tienda\/([a-z0-9-]+)$/i)
    if (!match) return
    const slug = match[1]
    if (['cart', 'login', 'cuenta', 'checkout'].includes(slug.toLowerCase())) return

    const name = (
      card.find('h2, h3').first().text()
      || img.attr('alt')
      || slug
    ).replace(/\s+/g, ' ').trim()

    const crumb = card.find('p').first().text().replace(/\s+/g, ' ').trim()
    const brand = crumb.includes('/')
      ? crumb.split('/').pop()?.trim()
      : undefined

    const priceText = card.text().match(/\$\s*([\d.,]+)/)?.[1]
    const cardText = card.text().toLowerCase()
    const available = !/(agotado|sin stock|sold out|out of stock)/i.test(cardText)

    const current = found.get(slug)
    found.set(slug, {
      slug,
      name: name || current?.name || slug,
      price: parseEckoPrice(priceText ?? '') ?? current?.price,
      imageUrl: imageUrl || current?.imageUrl,
      brand: brand || current?.brand,
      href: url.toString(),
      available: current ? current.available && available : available,
    })
  })

  return [...found.values()]
}

async function enrichFromDetail(product: ListedProduct, root: string) {
  const html = await fetchHtml(product.href)
  const $ = cheerio.load(html)
  const name = $('h1').first().text().replace(/\s+/g, ' ').trim() || product.name

  const priceText = $('h1').first().parent().parent().find('p').filter((_i, el) => /\$/.test($(el).text())).first().text()
    || $('main').text().match(/\$\s*([\d.,]+)/)?.[0]
    || ''
  const price = parseEckoPrice(priceText) ?? product.price

  const bodyText = $('main').text().toLowerCase()
  const available = product.available
    && !/(agotado|sin stock|sold out|out of stock)/i.test(bodyText)

  const crumbBrand = $('main p').filter((_i, el) => /relojes\s*\//i.test($(el).text())).first().text()
    .split('/')
    .pop()
    ?.trim()

  const description = sanitizeSourceDescription(
    $('meta[name="description"]').attr('content')?.trim()
    || $('main p').filter((_i, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim()
      return text.length > 40 && !/relojes\s*\//i.test(text) && !/^\$/.test(text)
    }).first().text().replace(/\s+/g, ' ').trim()
    || undefined,
  )

  // Única imagen confiable: la del listado. La ficha solo trae relacionados.
  const imageUrls = product.imageUrl ? [upgradeImageUrl(product.imageUrl)] : []

  return {
    sku: `ECKO-${product.slug}`,
    name,
    description,
    sourcePriceUsd: price,
    category: ORIGINAL_WATCHES_CATEGORY,
    brand: product.brand || crumbBrand || undefined,
    imageUrls,
    available,
    sourceUrl: product.href.startsWith('http') ? product.href : `${root}/tienda/${product.slug}`,
  } satisfies CatalogProduct
}

export async function fetchEckoJoyasProducts(baseUrl = process.env.ECKO_JOYAS_URL ?? DEFAULT_BASE) {
  const root = baseUrl.replace(/\/$/, '')
  const listed = new Map<string, ListedProduct>()

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
      if (!enriched.imageUrls.length) {
        console.warn(`Ecko: sin imagen de listado para ${item.slug}`)
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
          brand: item.brand,
          imageUrls: item.imageUrl ? [upgradeImageUrl(item.imageUrl)] : [],
          available: item.available,
          sourceUrl: item.href,
        })
      }
    }
    await sleep(250)
  }

  return products
}
