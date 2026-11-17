import { describe, it, expect, beforeEach } from 'vitest';

// Minimal localStorage for the Node test environment
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
const { getFolderView, saveFolderView } = await import('../services/folderViews');

describe('per-folder view settings', () => {
    beforeEach(() => store.clear());

    it('merges and returns saved settings per folder', () => {
        saveFolderView('/Users/a/Downloads', { viewMode: 'details' });
        saveFolderView('/Users/a/Downloads', { sortKey: 'date_added', direction: 'desc' });
        expect(getFolderView('/Users/a/Downloads')).toMatchObject({ viewMode: 'details', sortKey: 'date_added', direction: 'desc' });
        expect(getFolderView('/Users/a/Documents')).toBeNull();
        expect(getFolderView(null)).toBeNull();
    });

    it('keeps the number of remembered folders bounded', () => {
        for (let i = 0; i < 520; i++) saveFolderView(`/f${i}`, { viewMode: 'grid' });
        const saved = JSON.parse(store.get('explr.folderViews.v1'));
        expect(Object.keys(saved).length).toBeLessThanOrEqual(500);
        expect(getFolderView('/f519')).not.toBeNull();
    });
});
