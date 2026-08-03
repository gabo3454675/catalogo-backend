import { slugify } from './slug.js'

const KNOWN_BRANDS = [
  'Audemars Piguet',
  'Patek Philippe',
  'Richard Mille',
  'Richard Miller',
  'Maurice Lacroix',
  'Bell & Ross',
  'Bell Ross',
  'Technomarine',
  'Techonmarine',
  'Victorinox',
  'Montblanc',
  'Breitling',
  'G-Shock',
  'G-chock',
  'Portive',
  'Poedagar',
  'Invicta',
  'Hublot',
  'Cartier',
  'Citizen',
  'Curren',
  'Swatch',
  'Tissot',
  'Tommy',
  'Smael',
  'Snille',
  'Skmeii',
  'Skmei',
  'Seiko',
  'Rolex',
  'Casio',
  'Omega',
  'Oakley',
  'Orient',
  'Bulgari',
  'Bvlgari',
  'Tudor',
  'Mulco',
  'Dmax',
  'Max',
  'Tag Heuer',
  'Tagheuer',
  'TAG Heuer',
  'Tag',
] as const

const BRAND_ALIASES: Record<string, string> = {
  'richard miller': 'Richard Mille',
  'techonmarine': 'Technomarine',
  'g-chock': 'G-Shock',
  'g chock': 'G-Shock',
  'g-shock': 'G-Shock',
  skmeii: 'Skmei',
  'patek philipie': 'Patek Philippe',
  'patek philippe': 'Patek Philippe',
  'audemars piguet': 'Audemars Piguet',
  'maurice lacroix': 'Maurice Lacroix',
  'bell ross': 'Bell & Ross',
  'bell & ross': 'Bell & Ross',
  tag: 'TAG Heuer',
  tagheuer: 'TAG Heuer',
  'tag heuer': 'TAG Heuer',
  bvlgari: 'Bulgari',
  bulgari: 'Bulgari',
  citzen: 'Citizen',
  orint: 'Orient',
  reloj: '',
}

const IGNORE_SOURCE_BRANDS = new Set([
  'multimarcas',
  'set-de-regalos',
  'general',
  'relojes',
  'tacticos',
])

function normalizeBrandName(value: string) {
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ')
  const alias = BRAND_ALIASES[key]
  if (alias === '') return undefined
  return alias || value.trim().replace(/\b\w/g, (char) => char.toUpperCase())
}

export function brandForProduct(name: string, sourceBrand?: string) {
  const compact = name.replace(/\s+/g, ' ').trim()
  const sorted = [...KNOWN_BRANDS].sort((a, b) => b.length - a.length)
  for (const brand of sorted) {
    const pattern = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i')
    if (pattern.test(compact)) {
      return normalizeBrandName(brand) ?? brand
    }
  }

  const tipo = compact.match(/\btipo\s+([a-z0-9][a-z0-9 .'-]{1,40})/i)?.[1]?.trim()
  if (tipo) {
    const cleaned = tipo.replace(/\b(con|sin|estuche|caja|lujo|caballero|dama)\b.*/i, '').trim()
    if (cleaned) return normalizeBrandName(cleaned) ?? cleaned
  }

  if (sourceBrand) {
    const slug = slugify(sourceBrand)
    if (!IGNORE_SOURCE_BRANDS.has(slug)) {
      return normalizeBrandName(sourceBrand) ?? sourceBrand.trim()
    }
  }

  return 'Otras marcas'
}

export function productTypeForName(name: string, categoryName: string) {
  const isWatchCategory = categoryName === 'Relojes' || categoryName === 'Relojería original'
  if (!isWatchCategory) {
    if (/set|combo|duo/i.test(name)) return 'Sets y combos'
    if (/bandoler/i.test(name)) return 'Bandoleros'
    if (/bols|morral|cartera/i.test(name)) return 'Bolsos'
    return categoryName
  }

  // Relojería original: clasificar por estilo real, no un único tipo genérico.
  if (/digital|led|smart/i.test(name) || /\bskmei\b/i.test(name)) return 'Digital'
  if (/semi[- ]?auto|automatico|automático/i.test(name)) return 'Automático'
  if (/g[- ]?shock|g[- ]?chock|tactico|táctico|oakley|sumergible|deport/i.test(name)) return 'Deportivo'
  if (/tipo\s+|rolex|hublot|patek|audemars|richard|omega|tag|bulgari|cartier|tudor|breitling/i.test(name)) return 'Estilo lujo'
  if (/cuarzo|quartz|funcional|pi[ñn]on/i.test(name)) return 'Cuarzo'
  if (/dama|mujer|lady/i.test(name)) return 'Dama'
  if (/caballero|hombre|unisex/i.test(name)) return 'Caballero / Unisex'
  return 'Clásico'
}

export function classifyProduct(name: string, sourceBrand?: string, categoryName = 'Relojes') {
  const brand = brandForProduct(name, sourceBrand)
  const productType = productTypeForName(name, categoryName)
  return { brand, productType }
}
