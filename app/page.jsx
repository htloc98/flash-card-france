import React from 'react'
import FlashcardApp from '../src/components/FlashcardApp.jsx'
import { currentUser } from '../src/server/auth.js'
import { configured } from '../src/server/access.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function Page({ searchParams }) {
  const params = await searchParams
  const user = await currentUser()
  return <FlashcardApp user={user} ready={configured()} authError={typeof params?.error === 'string' ? params.error : ''} />
}