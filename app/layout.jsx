import React from 'react'
import '../src/style.css'

export const metadata = {
  title: 'mot. | French flashcards',
  description: 'Votre carnet de français',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }) {
  return <html lang="vi"><body>{children}</body></html>
}