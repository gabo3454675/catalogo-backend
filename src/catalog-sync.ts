import { prisma } from './prisma.js'
import { classifyProduct } from './product-classify.js'
import { uploadRemoteImage } from './r2.js'
import {
  type BcvRate,
  categoryForProduct,
  findRate,
  isWatchCategory,
  markupForBase,
  markupForOriginalWatch,
  ORIGINAL_WATCHES_CATEGORY,
  roundUsdOwnerFavor,
  sanitizeSourceDescription,
  slugify,
} from './catalog-utils.js'

export {
  categoryForProduct,
  markupForBase,
  markupForOriginalWatch,
  ORIGINAL_WATCHES_CATEGORY,
  roundUsdOwnerFavor,
  slugify,
}

export type CatalogProduct = {
  sku: string
  name: string
  description?: string
  /** Costo en bolívares (fuentes VES como VOLKOVA). */
  sourcePriceBs?: number
  /** Costo/precio origen ya en USD (Lua, Ecko). */
  sourcePriceUsd?: number
  category: string
  brand?: string
  imageUrls: string[]
  available: boolean
  sourceUrl: string
}

const rateUrl = process.env.BCV_RATE_URL ?? 'https://ve.dolarapi.com/v1/euros/oficial'

export function priceProduct(
  product: Pick<CatalogProduct, 'sourcePriceBs' | 'sourcePriceUsd' | 'category' | 'name'>,
  rate: number,
) {
  const baseUsd = typeof product.sourcePriceUsd === 'number' && product.sourcePriceUsd > 0
    ? product.sourcePriceUsd
    : Number(product.sourcePriceBs ?? 0) / rate
  if (!(baseUsd > 0)) throw new Error(`Precio origen inválido para ${product.name}`)
  const categoryName = product.category || categoryForProduct(product.name)
  const isOriginalWatch = categoryName === ORIGINAL_WATCHES_CATEGORY
  const isWatch = isWatchCategory(categoryName) || categoryForProduct(product.name) === 'Relojes'
  const markupUsd = isOriginalWatch
    ? markupForOriginalWatch(baseUsd)
    : markupForBase(baseUsd, isWatch)
  return { price: roundUsdOwnerFavor(baseUsd + markupUsd), markupUsd, baseUsd }
}

/** Normaliza URLs de foto VOLKOVA al path canónico de mayor calidad disponible. */
export function normalizeSourceImageUrl(value: string) {
  try {
    const url = new URL(value)
    const match = url.pathname.match(/\/(?:resource\/volkovamen\/fotos\/)([^/]+\.(?:jpe?g|png|webp))$/i)
      || url.pathname.match(/\/fotos\/([^/]+\.(?:jpe?g|png|webp))$/i)
    if (match) return `https://xproservidor.com/resource/volkovamen/fotos/${match[1]}`
    return url.toString()
  } catch {
    return value
  }
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

/** Prefijos de relojería original: el sync VOLKOVA nunca debe tumbarlos. */
export const ORIGINAL_SKU_PREFIXES = ['LUA-', 'ECKO-'] as const

export async function beginCatalogSync(source: 'volkova' | 'original' = 'volkova') {
  const rate = await fetchBcvRate()
  return prisma.syncRun.create({
    data: {
      status: 'running',
      source,
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
    const categoryName = product.category?.trim() || categoryForProduct(product.name)
    const categorySlug = slugify(categoryName)
    const category = await prisma.category.upsert({
      where: { slug: categorySlug },
      update: { name: categoryName },
      create: { name: categoryName, slug: categorySlug },
    })
    const { brand: brandName, productType } = classifyProduct(product.name, product.brand, categoryName)
    const brandSlug = slugify(brandName)
    const brand = await prisma.brand.upsert({
      where: { slug: brandSlug },
      update: { name: brandName },
      create: { name: brandName, slug: brandSlug },
    })
    const { price, markupUsd, baseUsd } = priceProduct(product, rate)
    const description = sanitizeSourceDescription(product.description)
    // Fuentes USD: persistimos el origen como Bs equivalentes para que reprice() siga funcionando.
    const sourcePriceBs = typeof product.sourcePriceUsd === 'number' && product.sourcePriceUsd > 0
      ? Number((baseUsd * rate).toFixed(2))
      : product.sourcePriceBs
    const saved = await prisma.product.upsert({
      where: { slug },
      update: {
        sku: product.sku,
        name: product.name,
        description,
        price,
        sourcePriceBs,
        exchangeRate: rate,
        markupUsd,
        available: product.available,
        sourceUrl: product.sourceUrl,
        categoryId: category.id,
        brandId: brand.id,
        productType,
      },
      create: {
        sku: product.sku,
        slug,
        name: product.name,
        description,
        price,
        sourcePriceBs,
        exchangeRate: rate,
        markupUsd,
        available: product.available,
        sourceUrl: product.sourceUrl,
        categoryId: category.id,
        brandId: brand.id,
        productType,
      },
    })

    const imageUrls = [...new Set(product.imageUrls.map(normalizeSourceImageUrl))].slice(0, 10)
    let coverImageUrl = existing?.images[0]?.url ?? saved.imageUrl
    const refreshImages = process.env.REFRESH_PRODUCT_IMAGES === '1'
    for (const [sortOrder, sourceImageUrl] of imageUrls.entries()) {
      const storedImage = existing?.images.find((image) => image.sortOrder === sortOrder)
      if (storedImage && !refreshImages) {
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
        if (storedImage && sortOrder === 0) coverImageUrl = storedImage.url
      }
    }
    if (coverImageUrl && coverImageUrl !== saved.imageUrl) {
      await prisma.product.update({ where: { id: saved.id }, data: { imageUrl: coverImageUrl } })
    }
    if (!existing) {
      productsAdded += 1
      await prisma.syncAddition.create({
        data: {
          syncRunId: runId,
          productId: saved.id,
          productName: saved.name,
          sku: saved.sku ?? undefined,
        },
      })
    }

    if (product.sku) {
      await prisma.syncSighting.upsert({
        where: { syncRunId_sku: { syncRunId: runId, sku: product.sku } },
        update: {},
        create: { syncRunId: runId, sku: product.sku },
      })
    }
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

export type CompleteCatalogSyncOptions = {
  /**
   * Si se indica, solo marca no disponibles productos cuyo SKU empieza por alguno
   * de estos prefijos (p. ej. LUA- / ECKO-). Evita tumbar el catálogo VOLKOVA.
   */
  skuPrefixes?: string[]
}

export async function completeCatalogSync(runId: string, options: CompleteCatalogSyncOptions = {}) {
  const sightings = await prisma.syncSighting.findMany({
    where: { syncRunId: runId },
    select: { sku: true },
  })
  const seenSkus = sightings.map((item) => item.sku)
  let productsUnavailable = 0
  const prefixes = (options.skuPrefixes ?? []).filter(Boolean)

  if (seenSkus.length > 0) {
    const result = await prisma.product.updateMany({
      where: {
        available: true,
        sku: { notIn: seenSkus },
        ...(prefixes.length > 0
          // Sync original: solo toca SKUs LUA-/ECKO-
          ? { OR: prefixes.map((prefix) => ({ sku: { startsWith: prefix } })) }
          // Sync VOLKOVA: nunca tumba relojería original
          : {
              AND: ORIGINAL_SKU_PREFIXES.map((prefix) => ({
                NOT: { sku: { startsWith: prefix } },
              })),
            }),
      },
      data: { available: false },
    })
    productsUnavailable = result.count
  }

  return prisma.syncRun.update({
    where: { id: runId },
    data: {
      status: 'success',
      completedAt: new Date(),
      productsUnavailable,
    },
  })
}

export async function failCatalogSync(runId: string, error: string) {
  return prisma.syncRun.update({
    where: { id: runId },
    data: { status: 'failed', completedAt: new Date(), error: error.slice(0, 2000) },
  })
}

export async function reclassifyCatalogProducts() {
  const products = await prisma.product.findMany({
    include: { category: true, brand: true },
  })
  let updated = 0
  for (const product of products) {
    const categoryName = product.category?.name ?? categoryForProduct(product.name)
    const { brand: brandName, productType } = classifyProduct(product.name, product.brand?.name, categoryName)
    const brand = await prisma.brand.upsert({
      where: { slug: slugify(brandName) },
      update: { name: brandName },
      create: { name: brandName, slug: slugify(brandName) },
    })
    if (product.brandId !== brand.id || product.productType !== productType) {
      await prisma.product.update({
        where: { id: product.id },
        data: { brandId: brand.id, productType },
      })
      updated += 1
    }
  }
  return { total: products.length, updated }
}

export async function repriceCatalogProducts() {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      name: true,
      price: true,
      sourcePriceBs: true,
      exchangeRate: true,
      markupUsd: true,
      category: { select: { name: true } },
    },
  })
  let updated = 0
  for (const product of products) {
    const rate = Number(product.exchangeRate ?? 0)
    const sourcePriceBs = Number(product.sourcePriceBs ?? 0)
    if (!(rate > 0) || !(sourcePriceBs > 0)) continue
    const { price, markupUsd } = priceProduct({
      name: product.name,
      sourcePriceBs,
      category: product.category?.name || categoryForProduct(product.name),
    }, rate)
    if (Number(product.price) === price && Number(product.markupUsd) === markupUsd) continue
    await prisma.product.update({
      where: { id: product.id },
      data: { price, markupUsd },
    })
    updated += 1
  }
  return { total: products.length, updated }
}
