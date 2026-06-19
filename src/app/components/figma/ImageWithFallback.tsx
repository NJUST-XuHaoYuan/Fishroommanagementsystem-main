import React, { useEffect, useState } from 'react'
import { cosProxyUrl, useResolvedMediaUrl } from '../../utils/media'

const ERROR_IMG_SRC =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODgiIGhlaWdodD0iODgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgc3Ryb2tlPSIjMDAwIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBvcGFjaXR5PSIuMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIzLjciPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjU2IiBoZWlnaHQ9IjU2IiByeD0iNiIvPjxwYXRoIGQ9Im0xNiA1OCAxNi0xOCAzMiAzMiIvPjxjaXJjbGUgY3g9IjUzIiBjeT0iMzUiIHI9IjciLz48L3N2Zz4KCg=='

type ImageWithFallbackProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  fallbackSrc?: string;
  fallbackAlt?: string;
  disableMediaProxy?: boolean;
};

export function ImageWithFallback(props: ImageWithFallbackProps) {
  const [didError, setDidError] = useState(false)
  const [forceProxy, setForceProxy] = useState(false)
  const [usingFallback, setUsingFallback] = useState(false)
  const {
    src,
    alt,
    style,
    className,
    loading = 'lazy',
    decoding = 'async',
    fallbackSrc,
    fallbackAlt,
    disableMediaProxy = false,
    ...rest
  } = props
  const originalSrc = typeof src === 'string' ? src : undefined
  const resolvedFallbackSrc = typeof fallbackSrc === 'string' ? fallbackSrc : undefined
  const activeSrc = (usingFallback || !originalSrc) ? resolvedFallbackSrc : originalSrc
  const proxySrc = disableMediaProxy ? undefined : cosProxyUrl(activeSrc)
  const resolvedSrc = useResolvedMediaUrl(disableMediaProxy ? undefined : activeSrc, { thumbnailWidth: 360 })
  const displaySrc = disableMediaProxy ? activeSrc : forceProxy && proxySrc ? proxySrc : resolvedSrc

  const handleError = () => {
    if (!usingFallback && resolvedFallbackSrc && resolvedFallbackSrc !== originalSrc) {
      setUsingFallback(true)
      setForceProxy(false)
      return
    }
    if (proxySrc && !forceProxy) {
      setForceProxy(true)
      return
    }
    setDidError(true)
  }

  useEffect(() => {
    setDidError(false)
    setForceProxy(false)
    setUsingFallback(false)
  }, [originalSrc, resolvedFallbackSrc])

  return didError ? (
    <div
      className={`inline-block bg-gray-100 text-center align-middle ${className ?? ''}`}
      style={style}
    >
      <div className="flex items-center justify-center w-full h-full">
        <img src={ERROR_IMG_SRC} alt="图片暂时无法加载" loading={loading} decoding={decoding} {...rest} data-original-url={src} />
      </div>
    </div>
  ) : (
    <img
      src={displaySrc}
      alt={usingFallback ? (fallbackAlt ?? alt) : alt}
      className={className}
      style={style}
      loading={loading}
      decoding={decoding}
      {...rest}
      onError={handleError}
    />
  )
}
