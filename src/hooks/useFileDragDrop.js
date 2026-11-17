import { useEffect, useRef } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

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

/** Finds the folder under a window position: a folder item, a sidebar entry or the open folder. */
function findDropTarget(position, currentPath) {
    const scale = window.devicePixelRatio || 1;
    const el = document.elementFromPoint(position.x / scale, position.y / scale);
    if (!el) return null;

    const folderItem = el.closest('.file-item.directory[data-path]');
    if (folderItem) return { path: folderItem.dataset.path, element: folderItem };

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
                    // Ignore dropping a folder onto itself
                    const sources = paths.filter((p) => p !== target.path);
                    if (!sources.length) return;
                    try {
                        const moved = await invoke('transfer_items', { paths: sources, targetDir: target.path });
                        s.onTransferred?.(moved, target.path);
                    } catch (err) {
                        s.onError?.(String(err));
                    }
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
