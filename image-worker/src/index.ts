export interface Env {
  IMAGES: R2Bucket
  UPLOAD_TOKEN: string
}

const imageKey = (pathname: string) => pathname.slice(1).startsWith('products/') && !pathname.includes('..')

export default {
  async fetch(request, env): Promise<Response> {
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1))
    if (!imageKey(`/${key}`)) return new Response('Not found', { status: 404 })

    if (request.method === 'GET' || request.method === 'HEAD') {
      const object = await env.IMAGES.get(key)
      if (!object) return new Response('Not found', { status: 404 })
      const headers = new Headers()
      object.writeHttpMetadata(headers)
      headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      headers.set('ETag', object.httpEtag)
      return new Response(request.method === 'HEAD' ? null : object.body, { headers })
    }

    if (request.method === 'PUT') {
      if (request.headers.get('Authorization') !== `Bearer ${env.UPLOAD_TOKEN}`) return new Response('Unauthorized', { status: 401 })
      if (!request.body || !request.headers.get('Content-Type')?.startsWith('image/')) return new Response('Invalid image', { status: 400 })
      await env.IMAGES.put(key, request.body, { httpMetadata: { contentType: request.headers.get('Content-Type') } })
      return Response.json({ key, url: new URL(request.url).toString() })
    }

    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, PUT' } })
  },
} satisfies ExportedHandler<Env>
