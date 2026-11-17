import { useEffect, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

// key -> asset URL | null (no icon) | Promise (in flight)
const iconCache = new Map();

const cacheKey = (path, isDirectory, size) => {
    if (isDirectory) return `d:${path}|${size}`;
    const name = path.split('/').pop() || '';
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return ext ? `e:${ext}|${size}` : `f:${path}|${size}`;
};

/**
 * Returns the Finder icon (asset URL) for a local file or folder on macOS,
 * or null while loading / when unavailable. Results are cached per extension.
 * @param {string|undefined} path - Absolute path; falsy disables the lookup
 * @param {boolean} isDirectory - Whether the path is a folder
 * @param {number} size - Icon size in pixels
 */
export default function useSystemIcon(path, isDirectory, size = 128) {
    const enabled = isMac && typeof path === 'string' && path.startsWith('/');
    const key = enabled ? cacheKey(path, isDirectory, size) : null;
    const [url, setUrl] = useState(() => {
        const cached = key ? iconCache.get(key) : null;
        return typeof cached === 'string' ? cached : null;
    });

    useEffect(() => {
        if (!key) {
            setUrl(null);
            return;
        }
        let cancelled = false;
        let entry = iconCache.get(key);
        if (typeof entry === 'string' || entry === null) {
            setUrl(entry);
            return;
        }
        if (!entry) {
            entry = invoke('get_file_icon', { path, isDirectory, size })
                .then((iconPath) => {
                    const assetUrl = convertFileSrc(iconPath);
                    iconCache.set(key, assetUrl);
                    return assetUrl;
                })
                .catch(() => {
                    iconCache.set(key, null);
                    return null;
                });
            iconCache.set(key, entry);
        }
        entry.then((value) => {
            if (!cancelled) setUrl(value);
        });
        return () => {
            cancelled = true;
        };
    }, [key, path, isDirectory, size]);

    return url;
}
