import assert from 'node:assert/strict'
import test from 'node:test'
import { isPrivateIp, validateRemoteImageUrl } from './remote-image.js'

test('acepta únicamente los orígenes HTTPS explícitos', () => {
  assert.equal(validateRemoteImageUrl('https://xproservidor.com/images/a.jpg').hostname, 'xproservidor.com')
  assert.equal(validateRemoteImageUrl('https://www.milcatalogos.com/images/a.webp').hostname, 'www.milcatalogos.com')
  assert.equal(validateRemoteImageUrl('https://luajoyeriaccs.com/wp-content/uploads/a.png').hostname, 'luajoyeriaccs.com')
  assert.equal(validateRemoteImageUrl('https://www.ecko-joyas.com/storage/products/a.webp').hostname, 'www.ecko-joyas.com')

  for (const url of [
    'http://xproservidor.com/a.jpg',
    'https://sub.xproservidor.com/a.jpg',
    'https://www.milcatalogos.com.evil.test/a.jpg',
    'https://user:pass@www.milcatalogos.com/a.jpg',
    'https://www.milcatalogos.com:8443/a.jpg',
    'https://127.0.0.1/a.jpg',
  ]) {
    assert.throws(() => validateRemoteImageUrl(url))
  }
})

test('bloquea rangos locales, privados, reservados y de documentación', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ]) {
    assert.equal(isPrivateIp(address), true, address)
  }

  assert.equal(isPrivateIp('1.1.1.1'), false)
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false)
})
