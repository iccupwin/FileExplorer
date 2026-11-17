import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

const isTyping = (target) =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;

/**
 * Space opens/closes the system Quick Look panel (macOS) for the selection,
 * starting at the focused item. While it is open, changing the selection in
 * Explr updates the panel, like Finder.
 */
export default function useQuickLook({ selectedItems, focusedItem, enabled = true }) {
    const openRef = useRef(false);
    const stateRef = useRef({ selectedItems, focusedItem });
    stateRef.current = { selectedItems, focusedItem };

    const itemsToShow = () => {
        const { selectedItems: sel, focusedItem: focus } = stateRef.current;
        const list = (sel.length ? sel : focus ? [focus] : []).filter((i) => typeof i.path === 'string' && i.path.startsWith('/'));
        const index = Math.max(0, focus ? list.findIndex((i) => i.path === focus.path) : 0);
        return { paths: list.map((i) => i.path), index };
    };

    useEffect(() => {
        if (!IS_MAC || !enabled) return undefined;
        const onKeyDown = async (e) => {
            if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            try {
                const isOpen = await invoke('quick_look_is_open');
                if (isOpen) {
                    await invoke('quick_look_close');
                    openRef.current = false;
                    return;
                }
                const { paths, index } = itemsToShow();
                if (!paths.length) return;
                await invoke('quick_look', { paths, index });
                openRef.current = true;
            } catch (err) {
                console.warn('Quick Look failed:', err);
            }
        };
        // Capture phase so the old in-app preview doesn't also react to Space
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [enabled]);

    // Keep the panel in sync with the selection while it is open
    useEffect(() => {
        if (!IS_MAC || !openRef.current) return;
        let cancelled = false;
        invoke('quick_look_is_open')
            .then((isOpen) => {
                if (cancelled) return;
                if (!isOpen) {
                    openRef.current = false;
                    return;
                }
                const { paths, index } = itemsToShow();
                if (paths.length) invoke('quick_look', { paths, index }).catch(() => {});
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [selectedItems, focusedItem]);
}
