import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEckoPrice } from './ecko-joyas.js'

test('parsea precios VE con punto de miles y coma decimal', () => {
  assert.equal(parseEckoPrice('$7.800,00'), 7800)
  assert.equal(parseEckoPrice('$1.100,00'), 1100)
  assert.equal(parseEckoPrice('210,50'), 210.5)
  assert.equal(parseEckoPrice('$595.00'), 595)
  assert.equal(parseEckoPrice('abc'), undefined)
})
