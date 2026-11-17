import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake backend: records calls and returns canned results
const calls = [];
const responses = {};
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async (cmd, args) => {
        calls.push([cmd, args]);
        const r = responses[cmd];
        return typeof r === 'function' ? r(args) : r;
    }),
    Channel: class { onmessage = null; },
}));

const fileOps = await import('../services/fileOps');

beforeEach(() => {
    calls.length = 0;
    for (const k of Object.keys(responses)) delete responses[k];
    fileOps.__resetForTests();
});

describe('undo', () => {
    it('puts trashed items back where they were', async () => {
        responses.trash_items = [
            { original: '/u/a.txt', trashed: '/u/.Trash/a.txt', error: null },
            { original: '/u/b.txt', trashed: null, error: 'denied' },
        ];
        responses.restore_items = ['/u/a.txt'];
        await fileOps.trash(['/u/a.txt', '/u/b.txt']);
        expect(fileOps.canUndo()).toBe(true);
        await fileOps.undo();
        expect(calls.at(-1)).toEqual(['restore_items', { moves: [{ from: '/u/.Trash/a.txt', to: '/u/a.txt' }] }]);
        expect(fileOps.canUndo()).toBe(false);
    });

    it('moves moved items back and trashes copies', async () => {
        responses.check_conflicts = [];
        responses.transfer_items = [
            { source: '/a/x', destination: '/b/x', operation: 'move' },
            { source: '/c/y', destination: '/b/y', operation: 'copy' },
        ];
        await fileOps.transfer(['/a/x', '/c/y'], '/b');
        responses.restore_items = [];
        responses.trash_items = [];
        await fileOps.undo();
        const names = calls.map(([c]) => c);
        expect(names.slice(-2)).toEqual(['restore_items', 'trash_items']);
        expect(calls.find(([c]) => c === 'restore_items')[1]).toEqual({ moves: [{ from: '/b/x', to: '/a/x' }] });
        expect(calls.at(-1)[1]).toEqual({ paths: ['/b/y'] });
    });

    it('undoes a rename and a newly created item', async () => {
        await fileOps.rename('/d/old.txt', '/d/new.txt');
        fileOps.recordCreated('/d/New Folder');
        await fileOps.undo(); // newest first: the created folder goes to the Trash
        expect(calls.at(-1)).toEqual(['trash_items', { paths: ['/d/New Folder'] }]);
        await fileOps.undo();
        expect(calls.at(-1)).toEqual(['restore_items', { moves: [{ from: '/d/new.txt', to: '/d/old.txt' }] }]);
    });

    it('reports when there is nothing to undo', async () => {
        expect(await fileOps.undo()).toBe(false);
    });
});

describe('transfer conflicts', () => {
    it('asks once and passes the choice to the backend', async () => {
        responses.check_conflicts = ['x'];
        responses.transfer_items = [];
        const pending = fileOps.transfer(['/a/x'], '/b', { mode: 'copy' });
        await vi.waitFor(() => expect(fileOps.conflictStore.get()).not.toBeNull());
        expect(fileOps.conflictStore.get().names).toEqual(['x']);
        fileOps.conflictStore.get().resolve('replace');
        await pending;
        const [, args] = calls.find(([c]) => c === 'transfer_items');
        expect(args).toMatchObject({ paths: ['/a/x'], targetDir: '/b', mode: 'copy', conflict: 'replace' });
    });

    it('does nothing when the user cancels', async () => {
        responses.check_conflicts = ['x'];
        const pending = fileOps.transfer(['/a/x'], '/b');
        await vi.waitFor(() => expect(fileOps.conflictStore.get()).not.toBeNull());
        fileOps.conflictStore.get().resolve('cancel');
        expect(await pending).toEqual([]);
        expect(calls.some(([c]) => c === 'transfer_items')).toBe(false);
    });

    it('ignores dropping a folder onto itself and non-local paths', async () => {
        expect(await fileOps.transfer(['/b', 'sftp:host:/x'], '/b')).toEqual([]);
        expect(calls.length).toBe(0);
    });
});
