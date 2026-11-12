import NextAuth from 'next-auth'
import { authOptions } from '../../../../src/server/auth.js'
import { configured } from '../../../../src/server/access.js'

export const runtime = 'nodejs'

async function handler(request, context) {
  if (!configured()) return Response.json({ error: 'Authentication is not configured' }, { status: 503 })
  return NextAuth(authOptions)(request, context)
}

export { handler as GET, handler as POST }