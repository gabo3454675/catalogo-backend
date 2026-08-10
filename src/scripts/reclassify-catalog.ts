import 'dotenv/config'
import { reclassifyCatalogProducts } from '../catalog-sync.js'

const result = await reclassifyCatalogProducts()
console.log(JSON.stringify(result))
