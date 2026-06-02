import React, { useEffect, useMemo, useState } from 'react'
import { authHeaders } from '../../utils/authSession'

const ERROR_IMG_SRC =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODgiIGhlaWdodD0iODgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgc3Ryb2tlPSIjMDAwIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBvcGFjaXR5PSIuMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIzLjciPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjU2IiBoZWlnaHQ9IjU2IiByeD0iNiIvPjxwYXRoIGQ9Im0xNiA1OCAxNi0xOCAzMiAzMiIvPjxjaXJjbGUgY3g9IjUzIiBjeT0iMzUiIHI9IjciLz48L3N2Zz4KCg=='

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>()

function cosProxyUrl(src?: string) {
  if (typeof src !== 'string') return undefined
  try {
    const url = new URL(src)
    if (url.hostname.endsWith('.myqcloud.com') && url.hostname.includes('.cos.')) {
      return `/api/media/cos?url=${encodeURIComponent(src)}`
    }
  } catch {
    return undefined
  }
  return undefined
}

function initialDisplaySrc(src?: string) {
  return cosProxyUrl(src) ? undefined : src
}

export function ImageWithFallback(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [didError, setDidError] = useState(false)
  const { src, alt, style, className, loading = 'lazy', decoding = 'async', ...rest } = props
  const originalSrc = typeof src === 'string' ? src : undefined
  const proxySrc = useMemo(() => cosProxyUrl(originalSrc), [originalSrc])
  const [displaySrc, setDisplaySrc] = useState<string | undefined>(() => initialDisplaySrc(originalSrc))

  const handleError = () => {
    if (proxySrc && displaySrc !== proxySrc) {
      setDisplaySrc(proxySrc)
      return
    }
    setDidError(true)
  }

  useEffect(() => {
    setDidError(false)
    if (!originalSrc) {
      setDisplaySrc(undefined)
      return
    }
    if (!proxySrc) {
      setDisplaySrc(originalSrc)
      return
    }

    const cached = signedUrlCache.get(originalSrc)
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      setDisplaySrc(cached.url)
      return
    }

    let cancelled = false
    setDisplaySrc(undefined)
    fetch(`/api/media/cos-url?url=${encodeURIComponent(originalSrc)}`, { headers: authHeaders() })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data) => {
        const signedUrl = typeof data?.url === 'string' ? data.url : ''
        if (!signedUrl) throw new Error('Missing signed URL')
        signedUrlCache.set(originalSrc, {
          url: signedUrl,
          expiresAt: Date.now() + Math.max(60, Number(data?.expiresIn ?? 3600) - 60) * 1000,
        })
        if (!cancelled) setDisplaySrc(signedUrl)
      })
      .catch(() => {
        if (!cancelled) setDisplaySrc(proxySrc)
      })

    return () => {
      cancelled = true
    }
  }, [originalSrc, proxySrc])

  return didError ? (
    <div
      className={`inline-block bg-gray-100 text-center align-middle ${className ?? ''}`}
      style={style}
    >
      <div className="flex items-center justify-center w-full h-full">
        <img src={ERROR_IMG_SRC} alt="Error loading image" loading={loading} decoding={decoding} {...rest} data-original-url={src} />
      </div>
    </div>
  ) : (
    <img src={displaySrc} alt={alt} className={className} style={style} loading={loading} decoding={decoding} {...rest} onError={handleError} />
  )
}
