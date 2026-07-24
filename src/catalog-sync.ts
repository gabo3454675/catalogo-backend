import { prisma } from './prisma.js'
import { uploadRemoteImage } from './r2.js'

export type CatalogProduct = {
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

type BcvRate = { value: number, updatedAt: Date }

const rateUrl = process.env.BCV_RATE_URL ?? 'https://ve.dolarapi.com/v1/euros/oficial'

export const slugify = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '')

const roundUsd = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

export function categoryForProduct(name: string) {
  if (/bandoler/i.test(name)) return 'Bandoleros'
  if (/bols|morral|cartera/i.test(name)) return 'Bolsos y morrales'
  if (/set|combo|duo/i.test(name)) return 'Sets y combos'
  return 'Relojes'
}

export function priceProduct(product: Pick<CatalogProduct, 'sourcePriceBs' | 'category' | 'name'>, rate: number) {
  const baseUsd = product.sourcePriceBs / rate
  const isWatch = categoryForProduct(product.name) === 'Relojes'
  const markupUsd = isWatch
    ? baseUsd >= 40 ? 20 : baseUsd >= 30 ? 15 : 10
    : baseUsd >= 80 ? 20 : baseUsd >= 40 ? 15 : baseUsd >= 20 ? 10 : 7
  return { price: roundUsd(baseUsd + markupUsd), markupUsd }
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
  const response = await fetch(rateUrl, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`BCV respondió ${response.status}`)
  const data: unknown = await response.json()
  const value = findRate(data)
  const record = data as Record<string, unknown>
  const timestamp = record.fechaActualizacion ?? record.updated_at ?? record.updatedAt
  if (!value || value <= 0) throw new Error('BCV no entregó una tasa EUR/VES válida.')
  return { value, updatedAt: timestamp ? new Date(String(timestamp)) : new Date() }
}

export async function beginCatalogSync() {
  const rate = await fetchBcvRate()
  return prisma.syncRun.create({
    data: {
      status: 'running',
      exchangeRate: rate.value,
      rateUpdatedAt: rate.updatedAt,
    },
  })
}

export async function persistCatalogBatch(runId: string, products: CatalogProduct[]) {
  const run = await prisma.syncRun.findUnique({ where: { id: runId } })
  if (!run || run.status !== 'running' || !run.exchangeRate) {
    throw new Error('La ejecución de sincronización no está disponible.')
  }

  const rate = Number(run.exchangeRate)
  let productsAdded = 0
  for (const product of products) {
    const slug = `${slugify(product.name)}-${slugify(product.sku)}`
    const existing = await prisma.product.findUnique({
      where: { slug },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    })
    const categoryName = categoryForProduct(product.name)
    const categorySlug = slugify(categoryName)
    const category = await prisma.category.upsert({
      where: { slug: categorySlug },
      update: { name: categoryName },
      create: { name: categoryName, slug: categorySlug },
    })
    const brandSlug = product.brand ? slugify(product.brand) : undefined
    const brand = brandSlug
      ? await prisma.brand.upsert({
        where: { slug: brandSlug },
        update: { name: product.brand! },
        create: { name: product.brand!, slug: brandSlug },
      })
      : undefined
    const { price, markupUsd } = priceProduct(product, rate)
    const saved = await prisma.product.upsert({
      where: { slug },
      update: {
        sku: product.sku,
        name: product.name,
        description: product.description,
        price,
        sourcePriceBs: product.sourcePriceBs,
        exchangeRate: rate,
        markupUsd,
        available: product.available,
        sourceUrl: product.sourceUrl,
        categoryId: category.id,
        brandId: brand?.id,
      },
      create: {
        sku: product.sku,
        slug,
        name: product.name,
        description: product.description,
        price,
        sourcePriceBs: product.sourcePriceBs,
        exchangeRate: rate,
        markupUsd,
        available: product.available,
        sourceUrl: product.sourceUrl,
        categoryId: category.id,
        brandId: brand?.id,
      },
    })

    const imageUrls = [...new Set(product.imageUrls)].slice(0, 10)
    let coverImageUrl = existing?.images[0]?.url ?? saved.imageUrl
    for (const [sortOrder, sourceImageUrl] of imageUrls.entries()) {
      const storedImage = existing?.images.find((image) => image.sortOrder === sortOrder)
      if (storedImage) {
        if (sortOrder === 0) coverImageUrl = storedImage.url
        continue
      }
      try {
        const imageUrl = await uploadRemoteImage(sourceImageUrl, `products/${slug}/${sortOrder}.jpg`)
        await prisma.productImage.upsert({
          where: { productId_sortOrder: { productId: saved.id, sortOrder } },
          update: { url: imageUrl },
          create: { productId: saved.id, sortOrder, url: imageUrl },
        })
        if (sortOrder === 0) coverImageUrl = imageUrl
      } catch (error) {
        console.warn(`No se pudo importar imagen ${sortOrder + 1} de ${product.sku}:`, error)
      }
    }
    if (coverImageUrl && coverImageUrl !== saved.imageUrl) {
      await prisma.product.update({ where: { id: saved.id }, data: { imageUrl: coverImageUrl } })
    }
    if (!existing) productsAdded += 1
  }

  await prisma.syncRun.update({
    where: { id: runId },
    data: {
      productsFound: { increment: products.length },
      productsAdded: { increment: productsAdded },
    },
  })
  return { productsAdded }
}

export async function completeCatalogSync(runId: string) {
  return prisma.syncRun.update({
    where: { id: runId },
    data: { status: 'success', completedAt: new Date() },
  })
}

export async function failCatalogSync(runId: string, error: string) {
  return prisma.syncRun.update({
    where: { id: runId },
    data: { status: 'failed', completedAt: new Date(), error: error.slice(0, 2000) },
  })
}
