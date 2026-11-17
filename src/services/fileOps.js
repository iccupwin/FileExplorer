/**
 * Central place for local file operations (macOS Finder semantics):
 * move/copy with progress and name-conflict handling, Trash, rename,
 * and an undo stack (Cmd+Z) that records the inverse of every operation.
 *
 * Plain JS (no React) with tiny subscribable stores for the UI pieces:
 * progress panel, conflict dialog and "can undo" state.
 */
import { invoke, Channel } from '@tauri-apps/api/core';
import { t } from '../i18n';

/* ------------------------------------------------------------------ */
/* Small store helper                                                  */
/* ------------------------------------------------------------------ */
const createStore = (initial) => {
    let state = initial;
    const listeners = new Set();
    return {
        get: () => state,
        set: (next) => {
            state = typeof next === 'function' ? next(state) : next;
            listeners.forEach((l) => l());
        },
        subscribe: (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
    };
};

/** Running transfers: { [jobId]: { label, doneBytes, totalBytes, doneItems, totalItems, current } } */
export const progressStore = createStore({});
/** Pending conflict question: null | { names: string[], targetDir: string, resolve: Function } */
export const conflictStore = createStore(null);
/** Undo stack (newest last) */
export const undoStore = createStore([]);

const MAX_UNDO = 50;
let refreshHandler = () => {};
let errorHandler = (message) => console.warn(message);

/** Called after every operation and undo so the UI can refresh immediately. */
export const setRefreshHandler = (fn) => { refreshHandler = fn || (() => {}); };
/** Called with a readable message when an operation fails. */
export const setErrorHandler = (fn) => { errorHandler = fn || errorHandler; };

const isLocal = (p) => typeof p === 'string' && p.startsWith('/');
const baseName = (p) => p.split('/').filter(Boolean).pop() || p;

const pushUndo = (entry) => {
    undoStore.set((stack) => [...stack, entry].slice(-MAX_UNDO));
};

/* ------------------------------------------------------------------ */
/* Conflicts                                                           */
/* ------------------------------------------------------------------ */

/**
 * Asks the user how to handle name clashes.
 * @returns {Promise<'keep_both'|'replace'|'skip'|'cancel'>}
 */
const askConflict = (names, targetDir) =>
    new Promise((resolve) => {
        conflictStore.set({
            names,
            targetDir,
            resolve: (choice) => {
                conflictStore.set(null);
                resolve(choice);
            },
        });
    });

/* ------------------------------------------------------------------ */
/* Transfer (move / copy)                                              */
/* ------------------------------------------------------------------ */

let jobCounter = 0;

/**
 * Moves or copies items into a folder.
 * @param {string[]} paths - absolute source paths
 * @param {string} targetDir - destination folder
 * @param {{ mode?: 'auto'|'copy'|'move', silent?: boolean }} [options]
 * @returns {Promise<Array<{source: string, destination: string, operation: string}>>}
 */
export async function transfer(paths, targetDir, options = {}) {
    const mode = options.mode || 'auto';
    const sources = (paths || []).filter((p) => isLocal(p) && p !== targetDir);
    if (!sources.length || !isLocal(targetDir)) return [];

    let conflict = 'keep_both';
    try {
        const clashes = await invoke('check_conflicts', { paths: sources, targetDir });
        if (clashes.length) {
            const choice = await askConflict(clashes, targetDir);
            if (choice === 'cancel') return [];
            conflict = choice;
        }
    } catch {
        // Conflict check unavailable: fall back to numbered names
    }

    const jobId = `job-${Date.now()}-${++jobCounter}`;
    const label = mode === 'copy'
        ? t('Copying {count} items', { count: sources.length })
        : t('Moving {count} items', { count: sources.length });

    // Show the panel only for transfers that take a moment (like Finder)
    let shown = false;
    const showTimer = setTimeout(() => {
        shown = true;
        progressStore.set((jobs) => ({ ...jobs, [jobId]: { ...(jobs[jobId] || {}), label } }));
    }, 400);

    const onProgress = new Channel();
    onProgress.onmessage = (p) => {
        if (p.finished || p.cancelled) return;
        progressStore.set((jobs) => {
            if (!shown && !jobs[jobId]) return jobs;
            return {
                ...jobs,
                [jobId]: {
                    label,
                    doneBytes: p.done_bytes,
                    totalBytes: p.total_bytes,
                    doneItems: p.done_items,
                    totalItems: p.total_items,
                    current: p.current,
                },
            };
        });
    };

    try {
        const results = await invoke('transfer_items', {
            paths: sources,
            targetDir,
            mode,
            conflict,
            jobId,
            onProgress,
        });
        if (results.length) {
            pushUndo({
                label: mode === 'copy' ? t('Undo Copy') : t('Undo Move'),
                // moved items go back, copies go to the Trash
                restore: results.filter((r) => r.operation === 'move').map((r) => ({ from: r.destination, to: r.source })),
                trash: results.filter((r) => r.operation === 'copy').map((r) => r.destination),
            });
        }
        return results;
    } catch (err) {
        errorHandler(String(err));
        return [];
    } finally {
        clearTimeout(showTimer);
        progressStore.set((jobs) => {
            const { [jobId]: _done, ...rest } = jobs;
            return rest;
        });
        refreshHandler();
    }
}

/** Cancels a running transfer (already finished items stay, like Finder). */
export const cancelTransfer = (jobId) => invoke('cancel_transfer', { jobId }).catch(() => {});

/* ------------------------------------------------------------------ */
/* Trash, rename, create                                               */
/* ------------------------------------------------------------------ */

/**
 * Moves items to the Trash (recoverable; Cmd+Z puts them back).
 * @param {string[]} paths
 */
export async function trash(paths) {
    const local = (paths || []).filter(isLocal);
    if (!local.length) return [];
    try {
        const results = await invoke('trash_items', { paths: local });
        const restorable = results.filter((r) => r.trashed).map((r) => ({ from: r.trashed, to: r.original }));
        if (restorable.length) pushUndo({ label: t('Undo Move to Trash'), restore: restorable, trash: [] });
        const failed = results.filter((r) => r.error);
        if (failed.length) {
            errorHandler(failed.map((r) => `${baseName(r.original)}: ${r.error}`).join('\n'));
        }
        return results;
    } catch (err) {
        errorHandler(String(err));
        return [];
    } finally {
        refreshHandler();
    }
}

/**
 * Renames (or moves) one item and records the inverse for undo.
 * Throws on failure so callers can show their own message.
 */
export async function rename(oldPath, newPath) {
    await invoke('rename', { oldPath, newPath });
    pushUndo({ label: t('Undo Rename'), restore: [{ from: newPath, to: oldPath }], trash: [] });
    refreshHandler();
}

/** Records a newly created file or folder so Cmd+Z moves it to the Trash. */
export function recordCreated(path) {
    if (!isLocal(path)) return;
    pushUndo({ label: t('Undo New Item'), restore: [], trash: [path] });
}

/* ------------------------------------------------------------------ */
/* Undo                                                                */
/* ------------------------------------------------------------------ */

export const canUndo = () => undoStore.get().length > 0;

/** Reverts the most recent operation. */
export async function undo() {
    const stack = undoStore.get();
    if (!stack.length) return false;
    const entry = stack[stack.length - 1];
    undoStore.set(stack.slice(0, -1));
    try {
        if (entry.restore.length) {
            // Restore in reverse order so nested moves unwind correctly
            await invoke('restore_items', { moves: [...entry.restore].reverse() });
        }
        if (entry.trash.length) {
            await invoke('trash_items', { paths: entry.trash });
        }
        return true;
    } catch (err) {
        errorHandler(t('Could not undo: {error}', { error: String(err) }));
        return false;
    } finally {
        refreshHandler();
    }
}

/** For tests */
export const __resetForTests = () => {
    undoStore.set([]);
    progressStore.set({});
    conflictStore.set(null);
};
