'use client'

import React from 'react'

export default function ErrorPage({ reset }) {
  return <main className="empty-state"><h1>Không thể tải ứng dụng</h1><p role="alert">Vui lòng thử lại sau.</p><button className="button button-primary" onClick={reset}>Thử lại</button></main>
}