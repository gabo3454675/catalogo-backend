import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  markupForBase,
  markupForOriginalWatch,
  markupRateForOriginalWatch,
  ORIGINAL_WATCH_MARKUP_HIGH_USD,
  ORIGINAL_WATCH_MARKUP_MID_USD,
} from './catalog-utils.js'

test('original: 30% / 20% / 15% por tramo de costo', () => {
  assert.equal(markupRateForOriginalWatch(499), 0.3)
  assert.equal(markupRateForOriginalWatch(ORIGINAL_WATCH_MARKUP_MID_USD), 0.2)
  assert.equal(markupRateForOriginalWatch(1499), 0.2)
  assert.equal(markupRateForOriginalWatch(ORIGINAL_WATCH_MARKUP_HIGH_USD), 0.15)

  assert.equal(markupForOriginalWatch(400), 120)
  assert.equal(markupForOriginalWatch(800), 160)
  assert.equal(markupForOriginalWatch(2000), 300)
  assert.equal(markupForOriginalWatch(4400), 660)
})

test('imitación / VOLKOVA conserva el tope de 17 USD en relojes', () => {
  assert.equal(markupForBase(50, true), 17)
  assert.equal(markupForBase(200, true), 17)
  assert.equal(markupForBase(20, true), 10)
})
