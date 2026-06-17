import React, { useEffect, useState } from 'react'
import { cosProxyUrl, useResolvedMediaUrl } from '../../utils/media'

const ERROR_IMG_SRC =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODgiIGhlaWdodD0iODgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgc3Ryb2tlPSIjMDAwIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBvcGFjaXR5PSIuMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIzLjciPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjU2IiBoZWlnaHQ9IjU2IiByeD0iNiIvPjxwYXRoIGQ9Im0xNiA1OCAxNi0xOCAzMiAzMiIvPjxjaXJjbGUgY3g9IjUzIiBjeT0iMzUiIHI9IjciLz48L3N2Zz4KCg=='

export function ImageWithFallback(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [didError, setDidError] = useState(false)
  const [forceProxy, setForceProxy] = useState(false)
  const { src, alt, style, className, loading = 'lazy', decoding = 'async', ...rest } = props
  const originalSrc = typeof src === 'string' ? src : undefined
  const proxySrc = cosProxyUrl(originalSrc)
  const resolvedSrc = useResolvedMediaUrl(originalSrc, { thumbnailWidth: 360 })
  const displaySrc = forceProxy && proxySrc ? proxySrc : resolvedSrc

  const handleError = () => {
    if (proxySrc && !forceProxy) {
      setForceProxy(true)
      return
    }
    setDidError(true)
  }

  useEffect(() => {
    setDidError(false)
    setForceProxy(false)
  }, [originalSrc])

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
    <img
      src={displaySrc}
      alt={alt}
      className={className}
      style={style}
      loading={loading}
      decoding={decoding}
      {...rest}
      onError={handleError}
    />
  )
}
