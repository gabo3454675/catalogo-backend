import 'dotenv/config'
import cors from 'cors'
import { timingSafeEqual } from 'node:crypto'
import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import { z } from 'zod'
import {
  beginCatalogSync,
  completeCatalogSync,
  failCatalogSync,
  persistCatalogBatch,
  reclassifyCatalogProducts,
  repriceCatalogProducts,
} from './catalog-sync.js'
import { prisma } from './prisma.js'

const app = express()
const port = Number(process.env.PORT ?? 3000)
const allowedOrigins = process.env.CORS_ORIGIN?.split(',').map((value) => value.trim()) ?? []
const adminEmail = process.env.ADMIN_EMAIL ?? 'glonga10@gmail.com'

app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(helmet())
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true)
      return
    }
    callback(new Error('Origen no permitido por CORS'))
  },
}))

const publicApiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes; inténtalo de nuevo más tarde' },
})

const analyticsLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes de analítica' },
})

const internalApiLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes internas; inténtalo de nuevo más tarde' },
})

const syncJson = express.json({ limit: '750kb', strict: true })
const failureJson = express.json({ limit: '8kb', strict: true })
const publicJson = express.json({ limit: '16kb', strict: true })

const catalogProduct = z.object({
  sku: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(500),
  description: z.string().trim().max(10_000).optional(),
  sourcePriceBs: z.number().finite().positive(),
  category: z.string().trim().min(1).max(120),
  brand: z.string().trim().min(1).max(120).optional(),
  imageUrls: z.array(z.url()).max(10),
  available: z.boolean(),
  sourceUrl: z.url(),
})

const syncBatch = z.object({
  runId: z.string().cuid().optional(),
  products: z.array(catalogProduct).min(1).max(50),
  complete: z.boolean().optional(),
})

const syncFailure = z.object({
  runId: z.string().cuid(),
  error: z.string().trim().min(1).max(2_000),
})

const analyticsEvent = z.object({
  type: z.enum(['page_view', 'product_view', 'add_to_cart']),
  sessionId: z.string().trim().min(8).max(80).optional(),
  productId: z.string().trim().min(1).max(80).optional(),
  productName: z.string().trim().min(1).max(500).optional(),
  path: z.string().trim().max(300).optional(),
  metadata: z.string().trim().max(1_000).optional(),
})

function safeEqual(expected: string, received: string) {
  const left = Buffer.from(expected)
  const right = Buffer.from(received)
  return left.length === right.length && timingSafeEqual(left, right)
}

function isAuthorizedCatalogWorker(request: express.Request) {
  const configuredToken = process.env.CATALOG_SYNC_TOKEN
  const suppliedToken = request.get('X-Kronos-Sync-Token')
  if (!configuredToken || !suppliedToken) return false
  return safeEqual(configuredToken, suppliedToken)
}

function requireCatalogWorker(request: express.Request, response: express.Response, next: express.NextFunction) {
  if (!isAuthorizedCatalogWorker(request)) {
    response.status(401).json({ error: 'No autorizado' })
    return
  }
  next()
}

function requireAdmin(request: express.Request, response: express.Response, next: express.NextFunction) {
  const configuredToken = process.env.ADMIN_TOKEN
  const suppliedToken = request.get('X-Kronos-Admin-Token')
  if (!configuredToken || !suppliedToken || !safeEqual(configuredToken, suppliedToken)) {
    response.status(401).json({ error: 'No autorizado' })
    return
  }
  next()
}

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
const ceilMoney = (value: number) => Math.max(1, Math.ceil(roundMoney(value) - 1e-9))

function toPublicProduct<T extends {
  price: unknown
  exchangeRate?: unknown | null
  sourcePriceBs?: unknown | null
  markupUsd?: unknown | null
  [key: string]: unknown
}>(product: T) {
  const price = ceilMoney(Number(product.price))
  const rate = Number(product.exchangeRate ?? 0)
  const {
    exchangeRate: _exchangeRate,
    sourcePriceBs: _sourcePriceBs,
    markupUsd: _markupUsd,
    ...rest
  } = product
  return {
    ...rest,
    price,
    priceBs: rate > 0 ? ceilMoney(price * rate) : null,
  }
}

app.post('/api/v1/internal/catalog-sync', internalApiLimiter, requireCatalogWorker, syncJson, async (request, response, next) => {
  try {
    const batch = syncBatch.parse(request.body)
    const run = batch.runId
      ? await prisma.syncRun.findUnique({ where: { id: batch.runId } })
      : await beginCatalogSync()
    if (!run) {
      response.status(404).json({ error: 'Ejecución de sincronización no encontrada' })
      return
    }
    const { productsAdded } = await persistCatalogBatch(run.id, batch.products)
    const completed = batch.complete ? await completeCatalogSync(run.id) : undefined
    response.status(batch.runId ? 200 : 201).json({
      runId: run.id,
      productsReceived: batch.products.length,
      productsAdded,
      status: completed?.status ?? 'running',
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v1/internal/catalog-sync/fail', internalApiLimiter, requireCatalogWorker, failureJson, async (request, response, next) => {
  try {
    const failure = syncFailure.parse(request.body)
    await failCatalogSync(failure.runId, failure.error)
    response.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'kronos-api' })
})

app.use('/api/v1', publicApiLimiter)

app.get('/api/v1/sync-status', async (_request, response, next) => {
  try {
    response.json(await prisma.syncRun.findFirst({
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        completedAt: true,
        status: true,
        productsFound: true,
        productsAdded: true,
        rateUpdatedAt: true,
      },
    }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/v1/categories', async (_request, response, next) => {
  try {
    const categories = await prisma.category.findMany({
      where: { products: { some: {} } },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    })
    response.json(categories)
  } catch (error) {
    next(error)
  }
})

app.get('/api/v1/brands', async (request, response, next) => {
  try {
    const category = typeof request.query.category === 'string' ? request.query.category : undefined
    const brands = await prisma.brand.findMany({
      where: {
        products: {
          some: category ? { category: { slug: category } } : {},
        },
      },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            products: {
              where: category ? { category: { slug: category } } : undefined,
            },
          },
        },
      },
    })
    response.json(brands)
  } catch (error) {
    next(error)
  }
})

app.get('/api/v1/product-types', async (request, response, next) => {
  try {
    const category = typeof request.query.category === 'string' ? request.query.category : 'relojes'
    const brand = typeof request.query.brand === 'string' ? request.query.brand : undefined
    const grouped = await prisma.product.groupBy({
      by: ['productType'],
      where: {
        productType: { not: null },
        category: { slug: category },
        ...(brand ? { brand: { slug: brand } } : {}),
      },
      _count: { _all: true },
      orderBy: { productType: 'asc' },
    })
    response.json(grouped.map((row) => ({
      name: row.productType,
      slug: row.productType,
      count: row._count._all,
    })))
  } catch (error) {
    next(error)
  }
})

const productQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
  category: z.string().trim().optional(),
  brand: z.string().trim().optional(),
  type: z.string().trim().optional(),
  search: z.string().trim().optional(),
  sort: z.enum(['recent', 'name', 'price-asc', 'price-desc']).default('recent'),
})

const productSelect = {
  id: true,
  sku: true,
  name: true,
  slug: true,
  description: true,
  price: true,
  exchangeRate: true,
  available: true,
  imageUrl: true,
  productType: true,
  category: { select: { id: true, name: true, slug: true } },
  brand: { select: { id: true, name: true, slug: true } },
  images: { orderBy: { sortOrder: 'asc' as const }, select: { id: true, url: true, sortOrder: true } },
  createdAt: true,
  updatedAt: true,
} as const

app.get('/api/v1/products', async (request, response, next) => {
  try {
    const query = productQuery.parse(request.query)
    const where = {
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.brand ? { brand: { slug: query.brand } } : {}),
      ...(query.type ? { productType: query.type } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
    }
    const orderBy = query.sort === 'name'
      ? { name: 'asc' as const }
      : query.sort === 'price-asc'
        ? { price: 'asc' as const }
        : query.sort === 'price-desc'
          ? { price: 'desc' as const }
          : { createdAt: 'desc' as const }
    const [items, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: productSelect,
      }),
      prisma.product.count({ where }),
    ])
    response.json({
      items: items.map((item) => {
        const cover = item.imageUrl || item.images?.[0]?.url || null
        return toPublicProduct({
          ...item,
          imageUrl: cover,
          images: item.images?.length
            ? item.images
            : cover
              ? [{ id: `${item.id}-cover`, url: cover, sortOrder: 0 }]
              : [],
        })
      }),
      total,
      page: query.page,
      pages: Math.ceil(total / query.limit) || 1,
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v1/products/:slug', async (request, response, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { slug: request.params.slug },
      select: productSelect,
    })
    if (!product) {
      response.status(404).json({ error: 'Producto no encontrado' })
      return
    }
    const cover = product.imageUrl || product.images?.[0]?.url || null
    response.json(toPublicProduct({
      ...product,
      imageUrl: cover,
      images: product.images?.length
        ? product.images
        : cover
          ? [{ id: `${product.id}-cover`, url: cover, sortOrder: 0 }]
          : [],
    }))
  } catch (error) {
    next(error)
  }
})

app.post('/api/v1/analytics', analyticsLimiter, publicJson, async (request, response, next) => {
  try {
    const event = analyticsEvent.parse(request.body)
    await prisma.analyticsEvent.create({
      data: {
        type: event.type,
        sessionId: event.sessionId,
        productId: event.productId,
        productName: event.productName,
        path: event.path,
        metadata: event.metadata,
      },
    })
    response.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.get('/api/v1/admin/overview', requireAdmin, async (_request, response, next) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const [
      pageViews,
      productViews,
      addToCart,
      uniqueSessions,
      productsTotal,
      productsUnavailable,
      salesCount,
      sales,
      syncRuns,
      topCartProducts,
      topViewedProducts,
      chartEvents,
      chartSales,
    ] = await Promise.all([
      prisma.analyticsEvent.count({ where: { type: 'page_view', createdAt: { gte: since } } }),
      prisma.analyticsEvent.count({ where: { type: 'product_view', createdAt: { gte: since } } }),
      prisma.analyticsEvent.count({ where: { type: 'add_to_cart', createdAt: { gte: since } } }),
      prisma.analyticsEvent.findMany({
        where: { createdAt: { gte: since }, sessionId: { not: null } },
        distinct: ['sessionId'],
        select: { sessionId: true },
      }),
      prisma.product.count(),
      prisma.product.count({ where: { available: false } }),
      prisma.sale.count({ where: { soldAt: { gte: since } } }),
      prisma.sale.findMany({
        orderBy: { soldAt: 'desc' },
        take: 40,
        select: {
          id: true,
          productId: true,
          productName: true,
          sku: true,
          quantity: true,
          priceUsd: true,
          note: true,
          soldAt: true,
        },
      }),
      prisma.syncRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: 10,
        include: {
          additions: {
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: { id: true, productId: true, productName: true, sku: true, createdAt: true },
          },
        },
      }),
      prisma.analyticsEvent.groupBy({
        by: ['productId', 'productName'],
        where: { type: 'add_to_cart', createdAt: { gte: since }, productId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { productId: 'desc' } },
        take: 15,
      }),
      prisma.analyticsEvent.groupBy({
        by: ['productId', 'productName'],
        where: { type: 'product_view', createdAt: { gte: since }, productId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { productId: 'desc' } },
        take: 15,
      }),
      prisma.analyticsEvent.findMany({
        where: {
          createdAt: { gte: since },
          type: { in: ['page_view', 'product_view', 'add_to_cart'] },
        },
        select: { type: true, createdAt: true },
      }),
      prisma.sale.findMany({
        where: { soldAt: { gte: since } },
        select: { soldAt: true, quantity: true },
      }),
    ])

    const dayKey = (value: Date) => value.toISOString().slice(0, 10)
    const dailyMap = new Map<string, { date: string; pageViews: number; productViews: number; addToCart: number; sales: number }>()
    for (let offset = 29; offset >= 0; offset -= 1) {
      const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000)
      const key = dayKey(date)
      dailyMap.set(key, { date: key, pageViews: 0, productViews: 0, addToCart: 0, sales: 0 })
    }
    for (const event of chartEvents) {
      const bucket = dailyMap.get(dayKey(event.createdAt))
      if (!bucket) continue
      if (event.type === 'page_view') bucket.pageViews += 1
      if (event.type === 'product_view') bucket.productViews += 1
      if (event.type === 'add_to_cart') bucket.addToCart += 1
    }
    for (const sale of chartSales) {
      const bucket = dailyMap.get(dayKey(sale.soldAt))
      if (!bucket) continue
      bucket.sales += sale.quantity || 1
    }

    response.json({
      adminEmail,
      periodDays: 30,
      summary: {
        pageViews,
        productViews,
        addToCart,
        uniqueSessions: uniqueSessions.length,
        productsTotal,
        productsUnavailable,
        salesCount,
      },
      dailySeries: [...dailyMap.values()],
      sales: sales.map((sale) => ({
        ...sale,
        priceUsd: sale.priceUsd == null ? null : Number(sale.priceUsd),
      })),
      topCartProducts: topCartProducts.map((row) => ({
        productId: row.productId,
        productName: row.productName,
        count: row._count._all,
      })),
      topViewedProducts: topViewedProducts.map((row) => ({
        productId: row.productId,
        productName: row.productName,
        count: row._count._all,
      })),
      syncRuns: syncRuns.map((run) => ({
        id: run.id,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        status: run.status,
        productsFound: run.productsFound,
        productsAdded: run.productsAdded,
        productsUnavailable: run.productsUnavailable,
        rateUpdatedAt: run.rateUpdatedAt,
        error: run.error,
        additions: run.additions,
      })),
    })
  } catch (error) {
    next(error)
  }
})

const saleBody = z.object({
  productId: z.string().trim().min(1).max(80),
  quantity: z.coerce.number().int().min(1).max(50).default(1),
  note: z.string().trim().max(500).optional(),
})

app.get('/api/v1/admin/products', requireAdmin, async (request, response, next) => {
  try {
    const search = typeof request.query.search === 'string' ? request.query.search.trim() : ''
    if (search.length < 2) {
      response.json([])
      return
    }
    const products = await prisma.product.findMany({
      where: {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { sku: { contains: search, mode: 'insensitive' } },
        ],
      },
      take: 20,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        sku: true,
        name: true,
        price: true,
        available: true,
        imageUrl: true,
        brand: { select: { name: true } },
      },
    })
    response.json(products.map((product) => ({
      ...product,
      price: ceilMoney(Number(product.price)),
    })))
  } catch (error) {
    next(error)
  }
})

app.post('/api/v1/admin/sales', requireAdmin, publicJson, async (request, response, next) => {
  try {
    const body = saleBody.parse(request.body)
    const product = await prisma.product.findUnique({ where: { id: body.productId } })
    if (!product) {
      response.status(404).json({ error: 'Producto no encontrado' })
      return
    }
    const sale = await prisma.sale.create({
      data: {
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        quantity: body.quantity,
        priceUsd: product.price,
        note: body.note,
      },
    })
    response.status(201).json({
      id: sale.id,
      productId: sale.productId,
      productName: sale.productName,
      sku: sale.sku,
      quantity: sale.quantity,
      priceUsd: Number(sale.priceUsd),
      note: sale.note,
      soldAt: sale.soldAt,
    })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/v1/admin/sales/:id', requireAdmin, async (request, response, next) => {
  try {
    const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id
    await prisma.sale.delete({ where: { id } })
    response.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.post('/api/v1/admin/reclassify', requireAdmin, async (_request, response, next) => {
  try {
    response.json(await reclassifyCatalogProducts())
  } catch (error) {
    next(error)
  }
})

app.post('/api/v1/admin/reprice', requireAdmin, async (_request, response, next) => {
  try {
    response.json(await repriceCatalogProducts())
  } catch (error) {
    next(error)
  }
})

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error)
  const bodyError = error as { type?: string }
  if (bodyError.type === 'entity.too.large') {
    response.status(413).json({ error: 'El cuerpo de la solicitud supera el límite permitido' })
    return
  }
  if (bodyError.type === 'entity.parse.failed') {
    response.status(400).json({ error: 'JSON no válido' })
    return
  }
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: 'Parámetros no válidos', details: error.issues })
    return
  }
  response.status(500).json({ error: 'Error interno del servidor' })
})

app.listen(port, '0.0.0.0', () => {
  console.log(`API disponible en el puerto ${port}`)
})
