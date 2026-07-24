import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { z } from 'zod'
import { prisma } from './prisma.js'

const app = express()
const port = Number(process.env.PORT ?? 3000)
const allowedOrigins = process.env.CORS_ORIGIN?.split(',').map((value) => value.trim()) ?? []

app.use(express.json())
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true)
      return
    }
    callback(new Error('Origen no permitido por CORS'))
  },
}))

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'kronos-api' })
})

app.get('/api/v1/sync-status', async (_request, response, next) => {
  try {
    response.json(await prisma.syncRun.findFirst({ orderBy: { startedAt: 'desc' } }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/v1/categories', async (_request, response, next) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    })
    response.json(categories)
  } catch (error) {
    next(error)
  }
})

app.get('/api/v1/brands', async (_request, response, next) => {
  try {
    response.json(await prisma.brand.findMany({ orderBy: { name: 'asc' } }))
  } catch (error) {
    next(error)
  }
})

const productQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
  category: z.string().trim().optional(),
  brand: z.string().trim().optional(),
  search: z.string().trim().optional(),
  sort: z.enum(['recent', 'name', 'price-asc', 'price-desc']).default('recent'),
})

app.get('/api/v1/products', async (request, response, next) => {
  try {
    const query = productQuery.parse(request.query)
    const where = {
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.brand ? { brand: { slug: query.brand } } : {}),
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
        include: { category: true, brand: true },
      }),
      prisma.product.count({ where }),
    ])
    response.json({ items, total, page: query.page, pages: Math.ceil(total / query.limit) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v1/products/:slug', async (request, response, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { slug: request.params.slug },
      include: { category: true, brand: true },
    })
    if (!product) {
      response.status(404).json({ error: 'Producto no encontrado' })
      return
    }
    response.json(product)
  } catch (error) {
    next(error)
  }
})

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error)
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: 'Parámetros no válidos', details: error.issues })
    return
  }
  response.status(500).json({ error: 'Error interno del servidor' })
})

app.listen(port, '0.0.0.0', () => {
  console.log(`API disponible en el puerto ${port}`)
})
