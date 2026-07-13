import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'], }
