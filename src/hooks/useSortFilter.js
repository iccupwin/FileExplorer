import { useSyncExternalStore } from 'react';

/**
 * Finder-style sorting and filtering for the file list.
 * A tiny shared store (persisted in localStorage) so the toolbar menus and the
 * file list stay in sync without extra providers.
 */

export const SORT_OPTIONS = [
    { key: 'name', label: 'Name', defaultDirection: 'asc' },
    { key: 'kind', label: 'Kind', defaultDirection: 'asc' },
    { key: 'date_added', label: 'Date Added', defaultDirection: 'desc' },
    { key: 'last_modified', label: 'Date Modified', defaultDirection: 'desc' },
    { key: 'created', label: 'Date Created', defaultDirection: 'desc' },
    { key: 'size', label: 'Size', defaultDirection: 'desc' },
];

export const KIND_FILTERS = [
    { key: 'all', label: 'All Kinds' },
    { key: 'folder', label: 'Folders' },
    { key: 'image', label: 'Images' },
    { key: 'video', label: 'Movies' },
    { key: 'audio', label: 'Music' },
    { key: 'pdf', label: 'PDF Documents' },
    { key: 'document', label: 'Documents' },
    { key: 'archive', label: 'Archives' },
    { key: 'code', label: 'Source Code' },
    { key: 'other', label: 'Other' },
];

export const DATE_FILTERS = [
    { key: 'any', label: 'Any Time' },
    { key: 'today', label: 'Today', days: 1 },
    { key: '7d', label: 'Last 7 Days', days: 7 },
    { key: '30d', label: 'Last 30 Days', days: 30 },
    { key: 'year', label: 'Last 12 Months', days: 365 },
];

const KIND_EXTENSIONS = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tif', 'tiff', 'ico', 'heic', 'heif', 'raw', 'cr2', 'nef', 'arw', 'dng', 'psd', 'ai', 'eps'],
    video: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv', '3gp', 'mpg', 'mpeg'],
    audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'aif', 'opus', 'wma'],
    pdf: ['pdf'],
    document: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md', 'csv', 'epub'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'dmg', 'iso', 'pkg'],
    code: ['html', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'json', 'xml', 'yaml', 'yml', 'toml', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb', 'go', 'rs', 'swift', 'kt', 'sql', 'sh', 'zsh', 'bat', 'ps1', 'vue', 'svelte'],
};

const EXTENSION_TO_KIND = Object.entries(KIND_EXTENSIONS).reduce((map, [kind, exts]) => {
    exts.forEach((ext) => { map[ext] = kind; });
    return map;
}, {});

const KIND_ORDER = ['folder', 'image', 'video', 'audio', 'pdf', 'document', 'archive', 'code', 'other'];

/** Category of an item, used by the Kind sort and the Kind filter. */
export const getItemKind = (item) => {
    if (item.isDirectory) return 'folder';
    const name = item.name || '';
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return EXTENSION_TO_KIND[ext] || 'other';
};

/** Parses the backend timestamp ("YYYY-MM-DD HH:MM:SS", UTC) into epoch ms. */
export const parseTimestamp = (value) => {
    if (!value) return 0;
    const ms = Date.parse(String(value).replace(' ', 'T') + 'Z');
    return Number.isNaN(ms) ? 0 : ms;
};

const dateAddedOf = (item) => parseTimestamp(item.date_added) || parseTimestamp(item.created) || parseTimestamp(item.last_modified);

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const DEFAULT_STATE = {
    sortKey: 'name',
    direction: 'asc',
    foldersFirst: true,
    kindFilter: 'all',
    dateFilter: 'any',
    iconSize: 64,
};

export const ICON_SIZE_MIN = 32;
export const ICON_SIZE_MAX = 128;
export const ICON_SIZE_STEP = 16;

const STORAGE_KEY = 'explr.sortFilter.v1';

const load = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_STATE;
        const saved = JSON.parse(raw);
        return { ...DEFAULT_STATE, ...saved };
    } catch {
        return DEFAULT_STATE;
    }
};

let state = load();
const listeners = new Set();

const setState = (patch) => {
    state = { ...state, ...patch };
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // storage unavailable: keep in memory only
    }
    listeners.forEach((listener) => listener());
};

const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const sortFilterActions = {
    /** Selects a sort key; selecting the active key again flips the direction. */
    sortBy(key) {
        if (state.sortKey === key) {
            setState({ direction: state.direction === 'asc' ? 'desc' : 'asc' });
        } else {
            const option = SORT_OPTIONS.find((o) => o.key === key);
            setState({ sortKey: key, direction: option?.defaultDirection || 'asc' });
        }
    },
    setDirection(direction) {
        setState({ direction });
    },
    toggleFoldersFirst() {
        setState({ foldersFirst: !state.foldersFirst });
    },
    setKindFilter(kindFilter) {
        setState({ kindFilter });
    },
    setDateFilter(dateFilter) {
        setState({ dateFilter });
    },
    clearFilters() {
        setState({ kindFilter: 'all', dateFilter: 'any' });
    },
    /** Applies a saved per-folder sort without the "same key flips direction" behaviour. */
    setSort(sortKey, direction) {
        if (!SORT_OPTIONS.some((o) => o.key === sortKey)) return;
        if (state.sortKey === sortKey && state.direction === direction) return;
        setState({ sortKey, direction: direction === 'desc' ? 'desc' : 'asc' });
    },
    setIconSize(size) {
        const clamped = Math.max(ICON_SIZE_MIN, Math.min(ICON_SIZE_MAX, Math.round(Number(size) || 64)));
        setState({ iconSize: clamped });
    },
    zoomIcons(direction) {
        this.setIconSize(state.iconSize + direction * ICON_SIZE_STEP);
    },
};

/** Current sort/filter settings; re-renders on change. */
export default function useSortFilter() {
    return useSyncExternalStore(subscribe, () => state);
}

export const isFilterActive = (s) => s.kindFilter !== 'all' || s.dateFilter !== 'any';

/**
 * Applies the filters and sorting to a combined list of items
 * (each item has `isDirectory`).
 */
export const applySortFilter = (items, s) => {
    const dateOption = DATE_FILTERS.find((d) => d.key === s.dateFilter);
    let cutoff = 0;
    if (dateOption?.days) {
        const now = new Date();
        cutoff = dateOption.key === 'today'
            ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
            : now.getTime() - dateOption.days * 24 * 60 * 60 * 1000;
    }

    const filtered = items.filter((item) => {
        if (s.kindFilter !== 'all' && getItemKind(item) !== s.kindFilter) return false;
        if (cutoff && dateAddedOf(item) < cutoff) return false;
        return true;
    });

    const dir = s.direction === 'desc' ? -1 : 1;
    const byName = (a, b) => nameCollator.compare(a.name || '', b.name || '');

    const compare = (a, b) => {
        switch (s.sortKey) {
            case 'kind': {
                const diff = KIND_ORDER.indexOf(getItemKind(a)) - KIND_ORDER.indexOf(getItemKind(b));
                if (diff !== 0) return diff;
                const extA = (a.name || '').split('.').pop().toLowerCase();
                const extB = (b.name || '').split('.').pop().toLowerCase();
                return extA.localeCompare(extB) || byName(a, b);
            }
            case 'date_added':
                return dateAddedOf(a) - dateAddedOf(b) || byName(a, b);
            case 'last_modified':
            case 'created':
                return parseTimestamp(a[s.sortKey]) - parseTimestamp(b[s.sortKey]) || byName(a, b);
            case 'size': {
                const sizeA = a.isDirectory ? -1 : a.size_in_bytes || 0;
                const sizeB = b.isDirectory ? -1 : b.size_in_bytes || 0;
                return sizeA - sizeB || byName(a, b);
            }
            case 'name':
            default:
                return byName(a, b);
        }
    };

    return filtered.sort((a, b) => {
        if (s.foldersFirst && a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return compare(a, b) * dir;
    });
};
