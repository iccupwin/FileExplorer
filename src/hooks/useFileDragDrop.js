import { useEffect, useRef } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import * as fileOps from '../services/fileOps';

const DRAG_THRESHOLD = 5; // px the mouse must travel before a drag starts
const DROP_CLASS = 'drop-target';

/**
 * Starts a native macOS drag for `paths` (works with Finder, Desktop, Mail,
 * messengers...). Must be called while the mouse button is still down.
 */
export async function startNativeDrag(paths, isDirectory) {
    if (!paths.length) return;
    let image = null;
    try {
        image = await invoke('get_file_icon', { path: paths[0], isDirectory, size: 64 });
    } catch {
        // falls back to a 1×1 transparent image below
    }
    const transparentPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    await invoke('plugin:drag|start_drag', {
        item: paths,
        image: image || transparentPng,
        options: { mode: 'copy' },
        onEvent: new Channel(),
    });
}

/**
 * Mouse-down handler factory: turns a press-and-move on a file into a native drag.
 * @param {() => {paths: string[], isDirectory: boolean}} getDragItems - called once the drag starts
 */
export function beginDragGesture(event, getDragItems) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;

    const onMove = (e) => {
        if (started) return;
        if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return;
        started = true;
        cleanup();
        const { paths, isDirectory } = getDragItems();
        startNativeDrag(paths, isDirectory).catch((err) => console.warn('Drag failed:', err));
    };
    const cleanup = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', cleanup);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', cleanup);
}

/** Adds dropped folders to the sidebar Favorites (stored like the context-menu action). */
function addFavorites(paths) {
    try {
        const existing = JSON.parse(localStorage.getItem('fileExplorerFavorites') || '[]');
        const known = new Set(existing.map((f) => f.path));
        const added = paths
            .filter((p) => p.startsWith('/') && !known.has(p))
            .map((p) => ({ name: p.split('/').filter(Boolean).pop() || p, path: p, icon: 'folder' }));
        if (!added.length) return;
        localStorage.setItem('fileExplorerFavorites', JSON.stringify([...existing, ...added]));
        window.dispatchEvent(new CustomEvent('favorites-updated'));
    } catch {
        // storage unavailable: nothing to do
    }
}

/** Finds the folder under a window position: a folder item, a sidebar entry or the open folder. */
function findDropTarget(position, currentPath) {
    const scale = window.devicePixelRatio || 1;
    const el = document.elementFromPoint(position.x / scale, position.y / scale);
    if (!el) return null;

    const folderItem = el.closest('.file-item.directory[data-path]');
    if (folderItem) return { path: folderItem.dataset.path, element: folderItem };

    // Dropping folders on the Favorites section adds them (like Finder)
    const favorites = el.closest('[data-drop-favorites]');
    if (favorites && !el.closest('[data-drop-path]')) return { favorites: true, element: favorites };

    const sidebarItem = el.closest('[data-drop-path]');
    if (sidebarItem) {
        const path = sidebarItem.dataset.dropPath;
        if (path && path.startsWith('/')) return { path, element: sidebarItem };
        return null;
    }

    const list = el.closest('.file-list-container');
    if (list && currentPath && currentPath.startsWith('/')) return { path: currentPath, element: list };
    return null;
}

/**
 * Handles files dropped onto the window (from Finder or from Explr itself):
 * highlights the folder under the cursor and moves/copies the items there.
 */
export default function useFileDragDrop({ currentPath, onTransferred, onError }) {
    const stateRef = useRef({ currentPath, onTransferred, onError, highlighted: null });
    stateRef.current.currentPath = currentPath;
    stateRef.current.onTransferred = onTransferred;
    stateRef.current.onError = onError;

    useEffect(() => {
        const setHighlight = (element) => {
            const s = stateRef.current;
            if (s.highlighted === element) return;
            s.highlighted?.classList.remove(DROP_CLASS);
            element?.classList.add(DROP_CLASS);
            s.highlighted = element || null;
        };

        let unlisten = null;
        let disposed = false;
        getCurrentWebview()
            .onDragDropEvent(async (event) => {
                const { type } = event.payload;
                const s = stateRef.current;
                if (type === 'over' || type === 'enter') {
                    const target = event.payload.position && findDropTarget(event.payload.position, s.currentPath);
                    setHighlight(target?.element || null);
                } else if (type === 'leave') {
                    setHighlight(null);
                } else if (type === 'drop') {
                    const target = findDropTarget(event.payload.position, s.currentPath);
                    setHighlight(null);
                    const paths = event.payload.paths || [];
                    if (!target || !paths.length) return;
                    if (target.favorites) {
                        addFavorites(paths);
                        return;
                    }
                    // Ignore dropping a folder onto itself
                    const sources = paths.filter((p) => p !== target.path);
                    if (!sources.length) return;
                    // Finder semantics (move on same disk, copy across disks), with progress,
                    // conflict dialog and Cmd+Z undo
                    const results = await fileOps.transfer(sources, target.path, { mode: 'auto' });
                    s.onTransferred?.(results, target.path);
                }
            })
            .then((fn) => {
                if (disposed) fn();
                else unlisten = fn;
            })
            .catch(() => {});

        return () => {
            disposed = true;
            if (unlisten) unlisten();
            setHighlight(null);
        };
    }, []);
}
