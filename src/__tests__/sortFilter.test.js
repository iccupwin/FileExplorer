import { describe, it, expect } from 'vitest';
import { applySortFilter, getItemKind, parseTimestamp } from '../hooks/useSortFilter';

const items = [
    { name: 'file10.png', isDirectory: false, size_in_bytes: 500, date_added: '2026-11-17 08:00:00', last_modified: '2026-01-01 00:00:00', created: '2026-01-01 00:00:00' },
    { name: 'file2.png', isDirectory: false, size_in_bytes: 900, date_added: '2026-10-01 08:00:00', last_modified: '2026-11-10 00:00:00', created: '2026-01-02 00:00:00' },
    { name: 'Report.pdf', isDirectory: false, size_in_bytes: 100, date_added: '2025-01-01 08:00:00', last_modified: '2025-01-01 00:00:00', created: '2025-01-01 00:00:00' },
    { name: 'Zeta', isDirectory: true, date_added: '2026-11-16 00:00:00', last_modified: '2026-11-16 00:00:00', created: '2026-11-16 00:00:00' },
    { name: 'alpha', isDirectory: true, date_added: '2020-01-01 00:00:00', last_modified: '2020-01-01 00:00:00', created: '2020-01-01 00:00:00' },
];
const base = { sortKey: 'name', direction: 'asc', foldersFirst: true, kindFilter: 'all', dateFilter: 'any' };
const names = (s, now) => applySortFilter([...items], { ...base, ...s }, now).map((i) => i.name);

describe('applySortFilter', () => {
    it('sorts names naturally and case-insensitively with folders first', () => {
        expect(names({})).toEqual(['alpha', 'Zeta', 'file2.png', 'file10.png', 'Report.pdf']);
    });

    it('sorts by date added, newest first', () => {
        expect(names({ sortKey: 'date_added', direction: 'desc', foldersFirst: false }))
            .toEqual(['file10.png', 'Zeta', 'file2.png', 'Report.pdf', 'alpha']);
    });

    it('sorts by size with folders kept on top', () => {
        expect(names({ sortKey: 'size', direction: 'desc' })).toEqual(['Zeta', 'alpha', 'file2.png', 'file10.png', 'Report.pdf']);
    });

    it('filters by kind', () => {
        expect(names({ kindFilter: 'image' })).toEqual(['file2.png', 'file10.png']);
        expect(names({ kindFilter: 'folder' })).toEqual(['alpha', 'Zeta']);
    });

    it('does not mutate the input array', () => {
        const input = [...items];
        applySortFilter(input, { ...base, sortKey: 'size' });
        expect(input.map((i) => i.name)).toEqual(items.map((i) => i.name));
    });
});

describe('helpers', () => {
    it('parses backend UTC timestamps', () => {
        expect(parseTimestamp('2026-11-17 08:00:00')).toBe(Date.UTC(2026, 10, 17, 8, 0, 0));
        expect(parseTimestamp('')).toBe(0);
        expect(parseTimestamp('garbage')).toBe(0);
    });

    it('detects item kinds', () => {
        expect(getItemKind({ name: 'a.MOV' })).toBe('video');
        expect(getItemKind({ name: 'x', isDirectory: true })).toBe('folder');
        expect(getItemKind({ name: 'README' })).toBe('other');
    });
});
