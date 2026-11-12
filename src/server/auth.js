import 'server-only'
import GoogleProvider from 'next-auth/providers/google'
import { getServerSession } from 'next-auth'
import { configured, emailAllowed, googleAllowed } from './access.js'
import { createRepository, seedStatements } from './database.js'
import { execute } from './d1.js'
import { lessonEntries } from './lesson.js'

export const repository = createRepository(execute)

export const authOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [GoogleProvider({ clientId: process.env.GOOGLE_CLIENT_ID ?? '', clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '' })],
  session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: '/', error: '/' },
  callbacks: {
    async signIn({ account, profile }) {
      return configured() && account?.provider === 'google' && googleAllowed(profile)
    },
    async jwt({ token, account, profile }) {
      if (account) {
        if (account.provider !== 'google' || !googleAllowed(profile)) throw new Error('Access denied')
        const user = await repository.ensureUser(profile)
        await execute(seedStatements(user.id, await lessonEntries()))
        token.userId = user.id
        token.email = user.email
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.userId
      return session
    },
  },
}

export async function currentUser() {
  if (!configured()) return null
  const session = await getServerSession(authOptions)
  return session?.user?.id && emailAllowed(session.user.email) ? session.user : null
}