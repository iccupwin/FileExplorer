import React, { useEffect, useRef, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getFileIconType } from '../../utils/icons';

// Extensions rendered by macOS Quick Look (via the `get_thumbnail` backend command)
const QUICK_LOOK_EXTENSIONS = new Set([
    'pdf',
    'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv', '3gp',
    'heic', 'heif',
]);

// path|mtime -> asset URL (or null when no thumbnail exists), shared across folders
const thumbnailCache = new Map();

// Vector images are cheap to draw directly; everything else gets a cached thumbnail
const DIRECT_EXTENSIONS = new Set(['svg']);

/**
 * Decides how a file can be previewed in grid view.
 * 'image'     - load the file itself (SVG)
 * 'quicklook' - small cached thumbnail from the `get_thumbnail` backend command
 *               (raster images are downscaled in Rust, PDFs/videos via Quick Look)
 * @returns {'image'|'quicklook'|null}
 */
export const getThumbnailKind = (item, isDirectory) => {
    if (isDirectory || typeof item.path !== 'string' || item.path.startsWith('sftp:')) return null;
    const ext = item.name.includes('.') ? item.name.split('.').pop().toLowerCase() : '';
    if (DIRECT_EXTENSIONS.has(ext)) return 'image';
    if (getFileIconType(item.name) === 'image') return 'quicklook';
    return QUICK_LOOK_EXTENSIONS.has(ext) ? 'quicklook' : null;
};

/**
 * Finder-style thumbnail. Images load directly; PDFs and videos are rendered by
 * Quick Look once the item scrolls into view. Shows `fallback` until ready or on error.
 */
const Thumbnail = ({ item, kind, fallback }) => {
    const cacheKey = `${item.path}|${item.last_modified ?? ''}`;
    const containerRef = useRef(null);
    const [src, setSrc] = useState(() => {
        if (kind === 'image') return convertFileSrc(item.path);
        return thumbnailCache.get(cacheKey) || null;
    });
    const [failed, setFailed] = useState(kind === 'quicklook' && thumbnailCache.get(cacheKey) === null);

    useEffect(() => {
        if (kind === 'image') {
            setSrc(convertFileSrc(item.path));
            setFailed(false);
            return;
        }
        const cached = thumbnailCache.get(cacheKey);
        if (cached !== undefined) {
            setSrc(cached);
            setFailed(cached === null);
            return;
        }
        setSrc(null);
        setFailed(false);

        let cancelled = false;
        const el = containerRef.current;
        if (!el) return;

        const observer = new IntersectionObserver((entries) => {
            if (!entries.some(entry => entry.isIntersecting)) return;
            observer.disconnect();
            invoke('get_thumbnail', { path: item.path, size: 256 })
                .then((thumbPath) => {
                    const url = convertFileSrc(thumbPath);
                    thumbnailCache.set(cacheKey, url);
                    if (!cancelled) setSrc(url);
                })
                .catch(() => {
                    thumbnailCache.set(cacheKey, null);
                    if (!cancelled) setFailed(true);
                });
        }, { rootMargin: '600px' });

        observer.observe(el);
        return () => {
            cancelled = true;
            observer.disconnect();
        };
    }, [kind, cacheKey, item.path]);

    const isVideo = getFileIconType(item.name) === 'video';

    return (
        <div ref={containerRef} className={`file-thumbnail-wrapper ${isVideo ? 'is-video' : ''}`}>
            {src && !failed ? (
                <img
                    className="file-thumbnail"
                    src={src}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    onError={() => {
                        if (kind === 'quicklook') thumbnailCache.set(cacheKey, null);
                        setFailed(true);
                    }}
                />
            ) : (
                fallback
            )}
        </div>
    );
};

export default Thumbnail;
