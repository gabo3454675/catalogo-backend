import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  markupForBase,
  markupForOriginalWatch,
  ORIGINAL_WATCH_PRICE_SPLIT_USD,
} from './catalog-utils.js'

test('original: 30% bajo el umbral y 20% en piezas caras', () => {
  assert.equal(markupForOriginalWatch(500), 150)
  assert.equal(markupForOriginalWatch(ORIGINAL_WATCH_PRICE_SPLIT_USD - 1), Math.round((ORIGINAL_WATCH_PRICE_SPLIT_USD - 1) * 0.3))
  assert.equal(markupForOriginalWatch(ORIGINAL_WATCH_PRICE_SPLIT_USD), Math.round(ORIGINAL_WATCH_PRICE_SPLIT_USD * 0.2))
  assert.equal(markupForOriginalWatch(2000), 400)
})

test('imitación / VOLKOVA conserva el tope de 17 USD en relojes', () => {
  assert.equal(markupForBase(50, true), 17)
  assert.equal(markupForBase(200, true), 17)
  assert.equal(markupForBase(20, true), 10)
})
