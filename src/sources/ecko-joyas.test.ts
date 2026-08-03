import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEckoPrice, parseListing } from './ecko-joyas.js'

test('parsea precios VE con punto de miles y coma decimal', () => {
  assert.equal(parseEckoPrice('$7.800,00'), 7800)
  assert.equal(parseEckoPrice('$1.100,00'), 1100)
  assert.equal(parseEckoPrice('210,50'), 210.5)
  assert.equal(parseEckoPrice('$595.00'), 595)
  assert.equal(parseEckoPrice('abc'), undefined)
})

test('asocia cada tarjeta del listado con su propia imagen', () => {
  const html = `
    <div class="bg-white border rounded-lg overflow-hidden group flex flex-col relative">
      <div class="overflow-hidden aspect-square">
        <img src="https://www.ecko-joyas.com/storage/products/thumbs/aaa-santos.webp" alt="Cartier Santos" />
      </div>
      <div class="p-3">
        <p>Relojes / Cartier</p>
        <h2>Cartier Santos</h2>
        <p>$7.800,00</p>
        <a href="https://www.ecko-joyas.com/tienda/cartier-santos">Detalles</a>
      </div>
    </div>
    <div class="bg-white border rounded-lg overflow-hidden group flex flex-col relative">
      <div class="overflow-hidden aspect-square">
        <img src="https://www.ecko-joyas.com/storage/products/thumbs/bbb-bvlgari.webp" alt="Bvlgari" />
      </div>
      <div class="p-3">
        <p>Relojes / Bvlgari</p>
        <h2>Bvlgari Aluminium</h2>
        <p>$4.400,00</p>
        <a href="https://www.ecko-joyas.com/tienda/bvlgari-aluminium-ducati">Detalles</a>
      </div>
    </div>
  `

  const products = parseListing(html, 'https://www.ecko-joyas.com')
  assert.equal(products.length, 2)

  const santos = products.find((item) => item.slug === 'cartier-santos')
  const bvlgari = products.find((item) => item.slug === 'bvlgari-aluminium-ducati')
  assert.ok(santos)
  assert.ok(bvlgari)
  assert.match(santos!.imageUrl || '', /aaa-santos/)
  assert.match(bvlgari!.imageUrl || '', /bbb-bvlgari/)
  assert.equal(santos!.brand, 'Cartier')
  assert.equal(bvlgari!.brand, 'Bvlgari')
  assert.equal(santos!.price, 7800)
  assert.equal(bvlgari!.price, 4400)
})
