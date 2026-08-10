/**
 * Funciones compartidas entre catalog-sync (automática) e import-catalog (manual).
 *
 * NOTA: roundUsd y roundUsdOwnerFavor son INTENCIONALMENTE diferentes:
 *   - roundUsdOwnerFavor (sync automática): redondea SIEMPRE hacia arriba (techo),
 *     protegiendo el margen del negocio. Usado por catalog-sync.ts.
 *   - roundUsd (importación manual): redondeo estándar a 2 decimales.
 *     Usado por import-catalog.ts.
 * Si se unificaran, los precios existentes cambiarían. No hacerlo es intencional.
 */

import { slugify } from './slug.js'

export { slugify }

export type BcvRate = { value: number, updatedAt: Date }

export const ORIGINAL_WATCHES_CATEGORY = 'Relojería original'

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

/** Quita contactos / marcas de proveedor en textos que verá el cliente. */
export function sanitizeSourceDescription(text: string | undefined) {
  if (!text) return undefined
  const cleaned = text
    .replace(/\b(wha?ts?app|whasap|wsp)\b[^.\n]{0,120}/gi, '')
    .replace(/\b0?4\d{2}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '')
    .replace(/\b(lua\s*joyer[ií]a|ecko\s*joyas)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cleaned || undefined
}

export function categoryForProduct(name: string) {
  if (/bandoler/i.test(name)) return 'Bandoleros'
  if (/bols|morral|cartera/i.test(name)) return 'Bolsos y morrales'
  if (/set|combo|duo/i.test(name)) return 'Sets y combos'
  return 'Relojes'
}

export function isWatchCategory(categoryName: string) {
  return categoryName === 'Relojes' || categoryName === ORIGINAL_WATCHES_CATEGORY
}

/** Tramos de costo USD para markup de relojería original. */
export const ORIGINAL_WATCH_MARKUP_MID_USD = 500
export const ORIGINAL_WATCH_MARKUP_HIGH_USD = 1500

/**
 * Markup de relojería original (Lua/Ecko):
 * - < $500 → 30%
 * - $500–$1499.99 → 20%
 * - >= $1500 → 15%
 */
export function markupRateForOriginalWatch(baseUsd: number) {
  if (baseUsd < ORIGINAL_WATCH_MARKUP_MID_USD) return 0.3
  if (baseUsd < ORIGINAL_WATCH_MARKUP_HIGH_USD) return 0.2
  return 0.15
}

export function markupForOriginalWatch(baseUsd: number) {
  return Math.max(1, Math.round(baseUsd * markupRateForOriginalWatch(baseUsd)))
}

/**
 * Markup VOLKOVA / imitación (y no-reloj): porcentaje con piso/techo.
 * No aplica a Relojería original.
 */
export function markupForBase(baseUsd: number, isWatch: boolean) {
  if (isWatch) return Math.max(10, Math.min(17, Math.round(baseUsd * 0.34)))
  return Math.max(7, Math.min(15, Math.round(baseUsd * 0.26)))
}

/** Redondea el precio de venta hacia arriba (a favor del negocio), sin centavos. */
export const roundUsdOwnerFavor = (value: number) => {
  const cents = Math.round((value + Number.EPSILON) * 100) / 100
  return Math.max(1, Math.ceil(cents - 1e-9))
}

/** Redondeo estándar a 2 decimales (usado en importación manual). */
export const roundUsd = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

/**
 * Busca recursivamente un valor numérico de tasa en un objeto JSON
 * (acepta claves como 'promedio', 'venta', 'rate', 'value', etc.).
 */
export function findRate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['promedio', 'venta', 'compra', 'rate', 'mid', 'tasa', 'value', 'usd']) {
    const found = findRate(record[key])
    if (found) return found
  }
  return undefined
}
