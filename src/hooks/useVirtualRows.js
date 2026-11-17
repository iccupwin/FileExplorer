import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const OVERSCAN_ROWS = 6;

/**
 * Row virtualization for very large folders: only the rows in (and near) the
 * viewport are rendered; spacers keep the scroll height. Works for the icon
 * grid (several columns per row) and for list/details (one per row).
 * Rows must have a uniform height (the grid uses fixed rows in this mode).
 *
 * @param {Object} opts
 * @param {React.RefObject<HTMLElement>} opts.containerRef - scrolling element
 * @param {React.RefObject<HTMLElement>} opts.listRef - element holding the items
 * @param {number} opts.count - total number of items
 * @param {number} opts.columns - items per row (1 for lists)
 * @param {boolean} opts.enabled
 */
export default function useVirtualRows({ containerRef, listRef, count, columns, enabled }) {
    const cols = Math.max(1, columns || 1);
    const totalRows = Math.ceil(count / cols);
    const [range, setRange] = useState({ startRow: 0, endRow: Math.min(totalRows, 40) });
    const metrics = useRef({ rowH: 0, rowGap: 0, colGap: 0, cellW: 0, padTop: 0, padLeft: 0 });

    const measure = useCallback(() => {
        const list = listRef.current;
        if (!list) return false;
        const cs = getComputedStyle(list);
        const item = list.querySelector('.file-item');
        if (!item) return false;
        metrics.current = {
            rowH: item.offsetHeight,
            cellW: item.offsetWidth,
            rowGap: parseFloat(cs.rowGap) || 0,
            colGap: parseFloat(cs.columnGap) || 0,
            // Base padding without the virtual offset we add via --vtop
            padTop: (parseFloat(cs.paddingTop) || 0) - (parseFloat(list.style.getPropertyValue('--vtop')) || 0),
            padLeft: parseFloat(cs.paddingLeft) || 0,
        };
        return metrics.current.rowH > 0;
    }, [listRef]);

    const stride = () => metrics.current.rowH + metrics.current.rowGap;

    const update = useCallback(() => {
        const container = containerRef.current;
        const list = listRef.current;
        if (!enabled || !container || !list) return;
        if (!metrics.current.rowH && !measure()) return;
        const s = stride();
        const y = container.scrollTop - (list.offsetTop + metrics.current.padTop);
        const startRow = Math.max(0, Math.floor(y / s) - OVERSCAN_ROWS);
        const endRow = Math.min(totalRows, Math.ceil((y + container.clientHeight) / s) + OVERSCAN_ROWS);
        setRange((r) => (r.startRow === startRow && r.endRow === endRow ? r : { startRow, endRow }));
    }, [containerRef, listRef, enabled, totalRows, measure]);

    // Re-measure when layout inputs change, then compute the visible range
    useLayoutEffect(() => {
        if (!enabled) return undefined;
        metrics.current.rowH = 0;
        update();
        const container = containerRef.current;
        if (!container) return undefined;
        // Update synchronously on scroll: setRange bails out when the range is unchanged,
        // and this avoids a blank frame when scrolling fast.
        const onScroll = () => update();
        container.addEventListener('scroll', onScroll, { passive: true });
        const ro = window.ResizeObserver ? new ResizeObserver(() => { metrics.current.rowH = 0; update(); }) : null;
        ro?.observe(container);
        return () => {
            container.removeEventListener('scroll', onScroll);
            ro?.disconnect();
        };
    }, [enabled, cols, count, update, containerRef]);

    const startRow = enabled ? Math.min(range.startRow, totalRows) : 0;
    const endRow = enabled ? Math.min(Math.max(range.endRow, startRow), totalRows) : totalRows;
    const s = metrics.current.rowH ? stride() : 0;

    /** Scrolls so that item `index` is visible (works for rows that aren't rendered). */
    const scrollToIndex = useCallback((index) => {
        const container = containerRef.current;
        const list = listRef.current;
        if (!container || !list || !metrics.current.rowH) return;
        const row = Math.floor(index / cols);
        const top = list.offsetTop + metrics.current.padTop + row * stride();
        const bottom = top + metrics.current.rowH;
        if (top < container.scrollTop) container.scrollTop = top - 4;
        else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight + 4;
    }, [containerRef, listRef, cols]);

    /** Boxes of every item (rendered or not) in container content coordinates. */
    const getBoxes = useCallback((paths) => {
        const list = listRef.current;
        if (!list || !metrics.current.rowH) return [];
        const m = metrics.current;
        const st = stride();
        const baseTop = list.offsetTop + m.padTop;
        const baseLeft = list.offsetLeft + m.padLeft;
        return paths.map((path, i) => {
            const row = Math.floor(i / cols);
            const col = i % cols;
            const left = baseLeft + col * (m.cellW + m.colGap);
            const top = baseTop + row * st;
            return { path, left, right: left + m.cellW, top, bottom: top + m.rowH };
        });
    }, [listRef, cols]);

    return {
        startIndex: startRow * cols,
        endIndex: Math.min(count, endRow * cols),
        // Extra padding standing in for the rows that aren't rendered
        topSpacer: enabled && startRow > 0 && s ? startRow * s : 0,
        bottomSpacer: enabled && endRow < totalRows && s ? (totalRows - endRow) * s - m0(metrics.current.rowGap) : 0,
        scrollToIndex,
        getBoxes,
    };
}

const m0 = (gap) => Math.max(0, gap);
