import { createApi } from '../../../../src/server/api.js'
import { currentUser, repository } from '../../../../src/server/auth.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const handler = createApi({ getUser: currentUser, repository, origin: process.env.NEXTAUTH_URL })

export { handler as GET, handler as POST, handler as PUT, handler as DELETE }