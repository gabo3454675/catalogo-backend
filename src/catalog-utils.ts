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

export function categoryForProduct(name: string) {
  if (/bandoler/i.test(name)) return 'Bandoleros'
  if (/bols|morral|cartera/i.test(name)) return 'Bolsos y morrales'
  if (/set|combo|duo/i.test(name)) return 'Sets y combos'
  return 'Relojes'
}

/**
 * Markup suave: porcentaje con piso/techo.
 * Protege margen en baratos y evita saltos agresivos en medios/altos.
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
