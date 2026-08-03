import 'dotenv/config'
import {
  beginCatalogSync,
  completeCatalogSync,
  failCatalogSync,
  ORIGINAL_SKU_PREFIXES,
  persistCatalogBatch,
  type CatalogProduct,
} from '../catalog-sync.js'
import { fetchEckoJoyasProducts } from '../sources/ecko-joyas.js'
import { fetchLuaJoyeriaProducts } from '../sources/lua-joyeria.js'

const BATCH_SIZE = 15

async function collectOriginalProducts() {
  const [lua, ecko] = await Promise.all([
    fetchLuaJoyeriaProducts(),
    fetchEckoJoyasProducts(),
  ])
  console.log(`Lua Joyería: ${lua.length} productos`)
  console.log(`Ecko Joyas: ${ecko.length} productos`)

  const bySku = new Map<string, CatalogProduct>()
  for (const product of [...lua, ...ecko]) {
    bySku.set(product.sku, product)
  }
  return [...bySku.values()]
}

export async function syncOriginalWatches() {
  const run = await beginCatalogSync('original')
  try {
    const products = await collectOriginalProducts()
    if (products.length === 0) throw new Error('No se obtuvieron productos de Lua ni Ecko.')

    for (let index = 0; index < products.length; index += BATCH_SIZE) {
      const batch = products.slice(index, index + BATCH_SIZE)
      const result = await persistCatalogBatch(run.id, batch)
      console.log(`Lote ${Math.floor(index / BATCH_SIZE) + 1}: ${batch.length} procesados, ${result.productsAdded} nuevos`)
    }

    const completed = await completeCatalogSync(run.id, { skuPrefixes: [...ORIGINAL_SKU_PREFIXES] })
    console.log(`Sync original OK. found=${completed.productsFound} added=${completed.productsAdded} unavailable=${completed.productsUnavailable}`)
    return completed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await failCatalogSync(run.id, message)
    throw error
  }
}

const isMain = process.argv[1]?.includes('import-original-watches')
if (isMain) {
  syncOriginalWatches()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
