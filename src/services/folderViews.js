/**
 * Per-folder view settings (view mode, sort), like Finder's "remember view per folder".
 * Stored in localStorage; capped so it can't grow without bound.
 */
const KEY = 'explr.folderViews.v1';
const MAX_ENTRIES = 500;

const read = () => {
    try {
        return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    } catch {
        return {};
    }
};

/** @returns {{viewMode?: string, sortKey?: string, direction?: string} | null} */
export const getFolderView = (path) => (path ? read()[path] || null : null);

/** Merges `patch` into the saved settings for `path`. */
export const saveFolderView = (path, patch) => {
    if (!path) return;
    try {
        const all = read();
        const next = { ...(all[path] || {}), ...patch, t: Date.now() };
        all[path] = next;
        const keys = Object.keys(all);
        if (keys.length > MAX_ENTRIES) {
            // Drop the least recently changed folders
            keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0))
                .slice(0, keys.length - MAX_ENTRIES)
                .forEach((k) => delete all[k]);
        }
        localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
        // storage unavailable: the view just isn't remembered
    }
};
