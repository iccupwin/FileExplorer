import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_DRAG = 3;       // px before a press turns into a selection rectangle
const EDGE = 28;          // px from the top/bottom edge where auto-scroll starts
const MAX_SCROLL = 18;    // px per frame at the very edge

const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Finder-style rubber-band selection: press on empty space and drag a
 * rectangle over items. Cmd/Shift adds to the existing selection.
 *
 * @param {React.RefObject<HTMLElement>} containerRef - scrolling container holding the items
 * @param {Object} options
 * @param {Array} options.items - items in display order (each has `path`)
 * @param {Array} options.selectedItems - current selection
 * @param {Function} options.onSelect - called with the new selection (array of items)
 * @returns {{ onMouseDown: Function, rect: Object|null, consumeClick: () => boolean }}
 */
export default function useMarqueeSelection(containerRef, { items, selectedItems, onSelect, getBoxes = null }) {
    const [rect, setRect] = useState(null); // in container content coordinates
    const latest = useRef({ items, selectedItems, onSelect, getBoxes });
    latest.current = { items, selectedItems, onSelect, getBoxes };
    const suppressClickRef = useRef(false);
    const sessionRef = useRef(null);

    const stop = useCallback(() => {
        const s = sessionRef.current;
        if (!s) return;
        cancelAnimationFrame(s.raf);
        window.removeEventListener('mousemove', s.onMove);
        window.removeEventListener('mouseup', s.onUp);
        sessionRef.current = null;
        setRect(null);
    }, []);

    useEffect(() => stop, [stop]);

    const onMouseDown = useCallback((e) => {
        const container = containerRef.current;
        if (!container || e.button !== 0) return;
        // Only on empty space: not on an item, header, input or scrollbar
        if (e.target.closest('.file-item, .file-list-header, input, textarea, button')) return;
        const box = container.getBoundingClientRect();
        if (e.clientX > box.left + container.clientWidth) return; // scrollbar

        e.preventDefault();
        const additive = e.metaKey || e.ctrlKey || e.shiftKey;
        const toContent = (clientX, clientY) => {
            const b = container.getBoundingClientRect();
            return { x: clientX - b.left + container.scrollLeft, y: clientY - b.top + container.scrollTop };
        };

        // Item boxes in content coordinates (layout doesn't change during the drag)
        const b0 = container.getBoundingClientRect();
        // Virtualized lists provide computed boxes (rows off screen aren't in the DOM)
        const boxes = latest.current.getBoxes ? latest.current.getBoxes() : [];
        if (!latest.current.getBoxes) container.querySelectorAll('.file-item[data-path]').forEach((el) => {
            const r = el.getBoundingClientRect();
            boxes.push({
                path: el.dataset.path,
                left: r.left - b0.left + container.scrollLeft,
                right: r.right - b0.left + container.scrollLeft,
                top: r.top - b0.top + container.scrollTop,
                bottom: r.bottom - b0.top + container.scrollTop,
            });
        });

        const start = toContent(e.clientX, e.clientY);
        const base = additive ? latest.current.selectedItems : [];
        const session = { started: false, lastClient: { x: e.clientX, y: e.clientY }, raf: 0, lastKey: '' };

        const update = () => {
            const { x: cx, y: cy } = session.lastClient;
            const cur = toContent(cx, cy);
            const r = {
                left: Math.min(start.x, cur.x),
                top: Math.min(start.y, cur.y),
                right: Math.max(start.x, cur.x),
                bottom: Math.max(start.y, cur.y),
            };
            setRect(r);

            const hit = new Set(boxes.filter((bx) => intersects(r, bx)).map((bx) => bx.path));
            const basePaths = new Set(base.map((i) => i.path));
            const key = [...hit].join('\n');
            if (key !== session.lastKey) {
                session.lastKey = key;
                const next = latest.current.items.filter((i) => hit.has(i.path) || basePaths.has(i.path));
                latest.current.onSelect(next);
            }
        };

        const autoScroll = () => {
            const b = container.getBoundingClientRect();
            const y = session.lastClient.y;
            let dy = 0;
            if (y < b.top + EDGE) dy = -Math.min(MAX_SCROLL, (b.top + EDGE - y) / 2 + 2);
            else if (y > b.bottom - EDGE) dy = Math.min(MAX_SCROLL, (y - (b.bottom - EDGE)) / 2 + 2);
            if (dy) {
                container.scrollTop += dy;
                update();
            }
            session.raf = requestAnimationFrame(autoScroll);
        };

        session.onMove = (ev) => {
            session.lastClient = { x: ev.clientX, y: ev.clientY };
            if (!session.started) {
                if (Math.abs(ev.clientX - e.clientX) < MIN_DRAG && Math.abs(ev.clientY - e.clientY) < MIN_DRAG) return;
                session.started = true;
                if (!additive) latest.current.onSelect([]);
                session.raf = requestAnimationFrame(autoScroll);
            }
            update();
        };
        session.onUp = () => {
            // A real drag must not be followed by the "click on empty space clears selection" handler
            suppressClickRef.current = session.started;
            stop();
        };

        sessionRef.current = session;
        window.addEventListener('mousemove', session.onMove);
        window.addEventListener('mouseup', session.onUp);
    }, [containerRef, stop]);

    /** Returns true (once) if the click that follows a rubber-band drag should be ignored. */
    const consumeClick = useCallback(() => {
        const v = suppressClickRef.current;
        suppressClickRef.current = false;
        return v;
    }, []);

    return { onMouseDown, rect, consumeClick };
}
