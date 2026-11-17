import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useContextMenu } from '../../providers/ContextMenuProvider';
import { useHistory } from '../../providers/HistoryProvider';
import { invoke } from '@tauri-apps/api/core';
import { beginDragGesture } from '../../hooks/useFileDragDrop';
import useMarqueeSelection from '../../hooks/useMarqueeSelection';
import useVirtualRows from '../../hooks/useVirtualRows';

// Folders bigger than this render only the visible rows
const VIRTUAL_THRESHOLD = 1500;
import { showError } from '../../utils/NotificationSystem';
import FileItem from './FileItem';
import useSortFilter, { applySortFilter, isFilterActive, sortFilterActions } from '../../hooks/useSortFilter';
import EmptyState from './EmptyState';
import StatusBar from './StatusBar';
import { useI18n } from '../../i18n';
import './fileList.css';

/**
 * Component to display a list of files and directories
 * @param {Object} props - Component properties
 * @param {Object} props.data - The file/directory data to display
 * @param {boolean} props.isLoading - Whether the file list is currently loading
 * @param {string} [props.viewMode='grid'] - Display mode: 'grid', 'list', or 'details'
 * @param {boolean} [props.isSearching=false] - Whether the list is showing search results
 * @param {string} [props.searchTerm=''] - The search term being used
 * @param {boolean} [props.disableArrowKeys=false] - Whether to disable arrow key navigation
 * @param {Function} [props.onColumnsChange] - Callback when columns per row changes
 * @returns {React.ReactElement} File list component
 */
const FileList = ({ data, isLoading, viewMode = 'grid', isSearching = false, searchTerm = '', disableArrowKeys = false, onColumnsChange }) => {
    const { selectedItems, selectItem, selectMultiple, loadDirectory, clearSelection, focusedItem, setFocusedItem, openFile } = useFileSystem();
    const { openContextMenu, clipboard } = useContextMenu();
    const sortFilter = useSortFilter();
    const { t } = useI18n();
    const sortConfig = { key: sortFilter.sortKey, direction: sortFilter.direction };
    const [columnsPerRow, setColumnsPerRow] = useState(4); // Dynamic column calculation
    const containerRef = useRef(null);
    const listRef = useRef(null);
    // Selection anchor (Windows-style): Shift+click / Shift+arrow select the range
    // from this index to the target. A ref avoids stale values in key handlers.
    const anchorRef = useRef(-1);
    const setLastSelectedIndex = (index) => { anchorRef.current = index; };

    /**
     * Calculate columns per row based on container width and item size
     */
    const calculateColumnsPerRow = useCallback(() => {
        if (!containerRef.current || viewMode !== 'grid') {
            setColumnsPerRow(1);
            onColumnsChange?.(1);
            return;
        }

        const container = containerRef.current;
        
        // Try to get computed styles first
        const computedStyle = window.getComputedStyle(container);
        const gridTemplateColumns = computedStyle.getPropertyValue('grid-template-columns');
        
        // If CSS Grid is being used, count the columns from grid-template-columns
        if (gridTemplateColumns && gridTemplateColumns !== 'none') {
            const columns = gridTemplateColumns.split(' ').length;
            setColumnsPerRow(columns);
            onColumnsChange?.(columns);
            return;
        }
        
        // Fallback: Calculate based on container width
        const containerWidth = container.offsetWidth || container.clientWidth;
        
        if (containerWidth === 0) {
            // Container not ready yet, use default
            setColumnsPerRow(4);
            onColumnsChange?.(4);
            return;
        }
        
        // Try counting actual file items in the DOM
        const fileItems = container.querySelectorAll('[data-path]');
        if (fileItems.length >= 2) {
            const firstItem = fileItems[0];
            const firstItemRect = firstItem.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            
            let columnsInFirstRow = 1;
            for (let i = 1; i < fileItems.length; i++) {
                const itemRect = fileItems[i].getBoundingClientRect();
                if (Math.abs(itemRect.top - firstItemRect.top) < 10) {
                    // Same row (within 10px tolerance)
                    columnsInFirstRow++;
                } else {
                    // Different row, stop counting
                    break;
                }
            }
            
            if (columnsInFirstRow > 1) {
                setColumnsPerRow(columnsInFirstRow);
                onColumnsChange?.(columnsInFirstRow);
                return;
            }
        }
        
        // More conservative estimates for item width
        const estimatedItemWidth = 160;
        const gap = 12;
        const padding = 32;
        
        const availableWidth = containerWidth - padding;
        const columns = Math.max(1, Math.floor((availableWidth + gap) / (estimatedItemWidth + gap)));
        
        setColumnsPerRow(columns);
        onColumnsChange?.(columns);
    }, [viewMode, onColumnsChange]);

    // Calculate columns on mount and resize
    useEffect(() => {
        calculateColumnsPerRow();
        
        const handleResize = () => {
            setTimeout(calculateColumnsPerRow, 100);
        };
        
        window.addEventListener('resize', handleResize);
        
        // Use ResizeObserver if available for more accurate detection
        let resizeObserver;
        if (containerRef.current && window.ResizeObserver) {
            resizeObserver = new ResizeObserver(() => {
                setTimeout(calculateColumnsPerRow, 50);
            });
            resizeObserver.observe(containerRef.current);
        }
        
        return () => {
            window.removeEventListener('resize', handleResize);
            if (resizeObserver) {
                resizeObserver.disconnect();
            }
        };
    }, [calculateColumnsPerRow]);

    // Also recalculate when view mode changes or data changes
    useEffect(() => {
        setTimeout(calculateColumnsPerRow, 100);
    }, [viewMode, data, calculateColumnsPerRow]);

    /**
     * Returns sorted data based on current sort configuration
     * @returns {Array} Sorted array of files and directories
     */
    const getSortedData = () => {
        if (!data || (!data.directories?.length && !data.files?.length)) {
            return [];
        }

        // Combine directories and files, then apply the Finder-style sort and filters
        const combinedItems = [
            ...(data.directories || []).map(dir => ({ ...dir, isDirectory: true })),
            ...(data.files || []).map(file => ({ ...file, isDirectory: false }))
        ];
        const sortedItems = applySortFilter(combinedItems, sortFilter);

        return sortedItems;
    };

    /**
     * Handles click on the container (empty space)
     * @param {React.MouseEvent} e - The click event
     */
    const handleContainerClick = (e) => {
        // The click that ends a rubber-band selection must not clear it
        if (marquee.consumeClick()) return;
        // Clear when clicking empty space (container or gaps between items), not items
        if (!e.target.closest('.file-item, .file-list-header') && e.detail !== 0) {
            clearSelection();
            setLastSelectedIndex(-1);
        }
    };

    /**
     * Handles right-click context menu
     * @param {React.MouseEvent} e - The context menu event
     */
    const handleContextMenu = (e) => {
        // Always prevent default browser context menu in our container
        e.preventDefault();
        e.stopPropagation();

        const currentSortedItems = getSortedData();
        
        // Determine if we clicked on an item or empty space
        const clickedItem = e.target.closest('[data-path]');
        const item = clickedItem ? currentSortedItems.find(item => item.path === clickedItem.dataset.path) : null;

        openContextMenu(e, item);
    };

    // Get sorted data - call this before useEffects that need it
    // Sorting is expensive for big folders: only redo it when data or sort settings change
    const sortedItems = useMemo(getSortedData, [data, sortFilter]); // eslint-disable-line react-hooks/exhaustive-deps

    // Finder colour tags for the items in this folder (macOS), read in one call
    const [tagMap, setTagMap] = useState({});
    useEffect(() => {
        const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
        const paths = sortedItems.map(i => i.path).filter(p => typeof p === 'string' && p.startsWith('/'));
        if (!isMac || !paths.length) { setTagMap({}); return undefined; }
        let cancelled = false;
        const load = () => invoke('get_tags', { paths })
            .then(map => { if (!cancelled) setTagMap(map || {}); })
            .catch(() => { if (!cancelled) setTagMap({}); });
        load();
        window.addEventListener('tags-changed', load);
        return () => { cancelled = true; window.removeEventListener('tags-changed', load); };
    }, [sortedItems]);

    // O(1) lookups instead of scanning the selection for every item
    const selectedPaths = useMemo(() => new Set(selectedItems.map(i => i.path)), [selectedItems]);
    const cutPaths = useMemo(
        () => new Set(clipboard?.operation === 'cut' ? clipboard.items.map(i => i.path) : []),
        [clipboard]
    );

    // Stable item handlers (the real logic is defined further down and read through a ref),
    // so memoized FileItems don't re-render just because a new closure was created.
    const itemHandlersRef = useRef({});
    const onItemClick = useCallback((e, item, index) => itemHandlersRef.current.click(item, index, false, e), []);
    const onItemDoubleClick = useCallback((e, item, index) => itemHandlersRef.current.click(item, index, true), []);
    const onItemContextMenu = useCallback((e) => itemHandlersRef.current.contextMenu(e), []);
    const onItemMouseDown = useCallback((e, item, index) => itemHandlersRef.current.mouseDown(e, item, index), []);

    // Rubber-band selection on empty space (like Finder)
    // Very large folders: render only visible rows (fixed row height)
    const isVirtual = sortedItems.length > VIRTUAL_THRESHOLD;
    const virtualRows = useVirtualRows({
        containerRef,
        listRef,
        count: sortedItems.length,
        columns: viewMode === 'grid' ? columnsPerRow : 1,
        enabled: isVirtual,
    });
    const scrollToIndexRef = useRef(null);
    scrollToIndexRef.current = isVirtual ? virtualRows.scrollToIndex : null;

    const marquee = useMarqueeSelection(containerRef, {
        items: sortedItems,
        selectedItems,
        // Off-screen rows don't exist in the DOM when virtualized: use computed geometry
        getBoxes: isVirtual ? () => virtualRows.getBoxes(sortedItems.map(i => i.path)) : null,
        onSelect: (next) => {
            selectMultiple(next);
            if (next.length) {
                const last = next[next.length - 1];
                setFocusedItem(last);
                anchorRef.current = sortedItems.findIndex(i => i.path === next[0].path);
            }
        },
    });

    /**
     * Sets up keyboard event listeners for multi-selection
     */
    useEffect(() => {
        const handleKeyDown = (e) => {
            // Don't handle keys if user is typing in an input or textarea
            if (e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement ||
                e.target.isContentEditable ||
                disableArrowKeys) {
                return;
            }
            if (!sortedItems || sortedItems.length === 0) return;

            const isMod = e.ctrlKey || e.metaKey;
            const count = sortedItems.length;

            // Cmd/Ctrl + / - : icon size (icon view)
            if (isMod && !e.altKey && (e.key === '=' || e.key === '+' || e.key === '-')) {
                e.preventDefault();
                sortFilterActions.zoomIcons(e.key === '-' ? -1 : 1);
                return;
            }

            // Ctrl/Cmd+A: select all
            if (isMod && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
                e.preventDefault();
                selectMultiple([...sortedItems]);
                return;
            }

            // Return renames, like Finder (open with Cmd+Down or a double click)
            if (e.key === 'Enter') {
                const target = selectedItems.length === 1 ? selectedItems[0] : (selectedItems.length === 0 ? focusedItem : null);
                if (target) {
                    e.preventDefault();
                    document.dispatchEvent(new CustomEvent('open-rename-modal', { detail: { item: target } }));
                }
                return;
            }

            const navKeys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
            // Alt+Arrow is used for back/forward/up navigation elsewhere
            if (!navKeys.includes(e.key) || e.altKey) return;
            e.preventDefault();

            // Current position: focused item, else last selected item, else anchor
            let current = focusedItem ? sortedItems.findIndex(i => i.path === focusedItem.path) : -1;
            if (current === -1 && selectedItems.length > 0) {
                const last = selectedItems[selectedItems.length - 1];
                current = sortedItems.findIndex(i => i.path === last.path);
            }
            if (current === -1 && anchorRef.current >= 0 && anchorRef.current < count) {
                current = anchorRef.current;
            }

            const cols = viewMode === 'grid' ? Math.max(1, columnsPerRow) : 1;
            let next;
            if (current === -1) {
                next = e.key === 'End' ? count - 1 : 0;
            } else {
                switch (e.key) {
                    case 'ArrowRight':
                        next = Math.min(current + 1, count - 1);
                        break;
                    case 'ArrowLeft':
                        next = Math.max(current - 1, 0);
                        break;
                    case 'ArrowDown':
                        if (cols === 1) {
                            next = Math.min(current + 1, count - 1);
                        } else if (current + cols < count) {
                            next = current + cols;
                        } else {
                            // Partial last row below: jump to the last item, like Windows
                            const lastRow = Math.floor((count - 1) / cols);
                            next = Math.floor(current / cols) < lastRow ? count - 1 : current;
                        }
                        break;
                    case 'ArrowUp':
                        next = current - cols >= 0 ? current - cols : (cols === 1 ? 0 : current);
                        break;
                    case 'Home':
                        next = 0;
                        break;
                    case 'End':
                        next = count - 1;
                        break;
                    default:
                        return;
                }
            }

            const item = sortedItems[next];
            if (!item) return;

            if (e.shiftKey) {
                // Shift+Arrow: extend selection from the anchor to the new position
                if (anchorRef.current < 0 || anchorRef.current >= count) {
                    anchorRef.current = current >= 0 ? current : next;
                }
                const start = Math.min(anchorRef.current, next);
                const end = Math.max(anchorRef.current, next);
                selectMultiple(sortedItems.slice(start, end + 1));
            } else if (isMod) {
                // Ctrl/Cmd+Arrow: move focus only, keep selection
            } else {
                selectMultiple([item]);
                anchorRef.current = next;
            }
            setFocusedItem(item);

            // Keep the focused item visible (also when its row isn't rendered yet:
            // in virtual mode the position is computed, so scroll right away)
            if (scrollToIndexRef.current) {
                scrollToIndexRef.current(next);
                return;
            }
            requestAnimationFrame(() => {
                const el = document.querySelector(`.file-list [data-path="${CSS.escape(item.path)}"]`);
                if (el) el.scrollIntoView({ block: 'nearest' });
            });
        };

        const handleKeyUp = () => {};

        /**
         * Prevents default browser context menu while allowing scrolling
         * @param {MouseEvent} e - The mouse event
         */
        const preventDefaultContextMenu = (e) => {
            // Only prevent if the target is within our file list AND it's actually a right-click
            if (e.button === 2 && (e.target.closest('.file-list-container') || e.target.closest('.empty-state-container'))) {
                e.preventDefault();
            }
        };

        /**
         * Handles select-item events from context menu
         * @param {CustomEvent} e - The custom event
         */
        const handleSelectItem = (e) => {
            if (e.detail && e.detail.item) {
                selectItem(e.detail.item, false);
            }
        };

        /**
         * Handles clear selection events
         */
        const handleClearSelection = () => {
            clearSelection();
            setLastSelectedIndex(-1);
        };

        // Use passive listeners where possible to improve scroll performance
        // Note: keydown cannot be passive because we need preventDefault for arrow keys
        window.addEventListener('keydown', handleKeyDown, { passive: false });
        window.addEventListener('keyup', handleKeyUp, { passive: true });
        window.addEventListener('mousedown', preventDefaultContextMenu, { passive: false });
        document.addEventListener('select-item', handleSelectItem);
        document.addEventListener('clear-selection', handleClearSelection);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('mousedown', preventDefaultContextMenu);
            document.removeEventListener('select-item', handleSelectItem);
            document.removeEventListener('clear-selection', handleClearSelection);
        };
    }, [selectItem, selectMultiple, selectedItems, clearSelection, sortedItems, focusedItem, setFocusedItem, loadDirectory, openFile, viewMode, disableArrowKeys, columnsPerRow]);

    /**
     * Clears selection when displayed data changes
     */

    // Track if this is the first mount or a navigation (not a deselection)
    const isFirstMount = useRef(true);
    const { currentPath } = useHistory();
    const prevPathRef = useRef();

    useEffect(() => {
        // Clear selection only when the folder changes; live refreshes keep it
        if (prevPathRef.current !== currentPath) {
            clearSelection();
            setLastSelectedIndex(-1);
            prevPathRef.current = currentPath;
        }
    }, [currentPath, clearSelection]);

    useEffect(() => {
        // Only focus first item on first mount or navigation, not after deselection
        if (sortedItems.length > 0 && !focusedItem && isFirstMount.current) {
            setFocusedItem(sortedItems[0]);
            isFirstMount.current = false;
        }
    }, [sortedItems, focusedItem, setFocusedItem]);

    // If data is null or loading, show loading state
    if (isLoading) {
        return (
            <div className="file-list-container">
                <div className="loading-state">
                    <div className="loading-spinner"></div>
                    <p>{t('Loading...')}</p>
                </div>
            </div>
        );
    }

    // If data is empty, show empty state
    if (!data || (!data.directories?.length && !data.files?.length)) {
        return (
            <div className="file-list-container">
                <div
                    className="empty-state-container"
                    onClick={handleContainerClick}
                    onContextMenu={handleContextMenu}
                    style={{ height: '100%', width: '100%' }}
                >
                    <EmptyState
                        type={isSearching ? 'no-results' : 'empty-folder'}
                        searchTerm={isSearching ? searchTerm : undefined}
                    />
                </div>
            </div>
        );
    }

    /**
     * Handles changing the sort column/direction
     * @param {string} key - The column key to sort by
     */
    const handleSort = (key) => {
        sortFilterActions.sortBy(key);
    };

    /**
     * Handles item click (selection and opening)
     * @param {Object} item - The clicked item
     * @param {number} index - Index of the clicked item
     * @param {boolean} [isDoubleClick=false] - Whether this is a double-click
     */
    const handleItemClick = (item, index, isDoubleClick = false, event = null) => {
        // Always set the focused item when clicking on it
        setFocusedItem(item);

        // For double-click, open the item
        if (isDoubleClick) {
            if (item.isDirectory) {
                loadDirectory(item.path);
            } else {
                openFile(item.path);
            }
            return;
        }

        // For single click, handle selection (Windows Explorer semantics)
        const isShift = !!event?.shiftKey;
        const isMod = !!(event?.ctrlKey || event?.metaKey);

        if (isShift) {
            // Shift+click: select range from the anchor; anchor stays where it was
            let anchor = anchorRef.current;
            if (anchor < 0 || anchor >= sortedItems.length) {
                const focusedIdx = focusedItem ? sortedItems.findIndex(i => i.path === focusedItem.path) : -1;
                anchor = focusedIdx >= 0 ? focusedIdx : index;
                anchorRef.current = anchor;
            }
            const start = Math.min(anchor, index);
            const end = Math.max(anchor, index);
            const range = sortedItems.slice(start, end + 1);
            if (isMod) {
                // Ctrl+Shift+click: add range to existing selection
                const paths = new Set(selectedItems.map(i => i.path));
                selectMultiple([...selectedItems, ...range.filter(i => !paths.has(i.path))]);
            } else {
                selectMultiple(range);
            }
        } else if (isMod) {
            // Ctrl/Cmd+click: toggle this item, it becomes the new anchor
            const isAlreadySelected = selectedItems.some(selected => selected.path === item.path);
            selectMultiple(isAlreadySelected
                ? selectedItems.filter(selected => selected.path !== item.path)
                : [...selectedItems, item]);
            anchorRef.current = index;
        } else {
            selectMultiple([item]);
            anchorRef.current = index;
        }
        setFocusedItem(item);
    };

    itemHandlersRef.current = {
        click: handleItemClick,
        contextMenu: handleContextMenu,
        mouseDown: (e, item, index) => beginDragGesture(e, () => {
            // Drag the whole selection if the item is part of it (like Finder)
            const inSelection = selectedPaths.has(item.path);
            const dragged = inSelection ? selectedItems : [item];
            if (!inSelection) {
                selectMultiple([item]);
                anchorRef.current = index;
                setFocusedItem(item);
            }
            return {
                paths: dragged.map(d => d.path).filter(p => typeof p === 'string' && p.startsWith('/')),
                isDirectory: dragged.length === 1 && !!(dragged[0].isDirectory || 'sub_file_count' in dragged[0]),
            };
        }),
    };

    return (
        <div className="file-list-wrapper">
            <div
                ref={containerRef}
                className={`file-list-container view-mode-${viewMode.toLowerCase()} scrollable-content`}
                onClick={handleContainerClick}
                onMouseDown={marquee.onMouseDown}
                onContextMenu={handleContextMenu}
            >
                {marquee.rect && (
                    <div
                        className="marquee-rect"
                        style={{
                            left: marquee.rect.left,
                            top: marquee.rect.top,
                            width: marquee.rect.right - marquee.rect.left,
                            height: marquee.rect.bottom - marquee.rect.top,
                        }}
                    />
                )}
                {/* Details view header with sortable columns */}
                {viewMode === 'details' && (
                    <div className="file-list-header">
                        <div
                            className={`file-list-column column-name ${sortConfig.key === 'name' ? `sorted-${sortConfig.direction}` : ''}`}
                            onClick={() => handleSort('name')}
                        >
                            {t('Name')}
                            {sortConfig.key === 'name' && (
                                <span className={`sort-icon sort-${sortConfig.direction}`}></span>
                            )}
                        </div>
                        <div
                            className={`file-list-column column-size ${sortConfig.key === 'size' ? `sorted-${sortConfig.direction}` : ''}`}
                            onClick={() => handleSort('size')}
                        >
                            {t('Size')}
                            {sortConfig.key === 'size' && (
                                <span className={`sort-icon sort-${sortConfig.direction}`}></span>
                            )}
                        </div>
                        <div
                            className={`file-list-column column-type ${sortConfig.key === 'kind' ? `sorted-${sortConfig.direction}` : ''}`}
                            onClick={() => handleSort('kind')}
                        >
                            {t('Kind')}
                            {sortConfig.key === 'kind' && (
                                <span className={`sort-icon sort-${sortConfig.direction}`}></span>
                            )}
                        </div>
                        <div
                            className={`file-list-column column-modified ${sortConfig.key === 'last_modified' ? `sorted-${sortConfig.direction}` : ''}`}
                            onClick={() => handleSort('last_modified')}
                        >
                            {t('Date Modified')}
                            {sortConfig.key === 'last_modified' && (
                                <span className={`sort-icon sort-${sortConfig.direction}`}></span>
                            )}
                        </div>
                    </div>
                )}

                {/* Filters hid every item */}
                {sortedItems.length === 0 && isFilterActive(sortFilter) && (
                    <div className="filter-empty-state">
                        <p>{t('No items match the current filter.')}</p>
                        <button className="filter-clear-button" onClick={() => sortFilterActions.clearFilters()}>
                            {t('Clear Filter')}
                        </button>
                    </div>
                )}

                {/* File list content */}
                <div
                    ref={listRef}
                    className={`file-list view-mode-${viewMode.toLowerCase()} scrollable-content ${isVirtual ? 'virtual' : ''}`}
                    style={{
                        '--icon-size': `${sortFilter.iconSize}px`,
                        ...(isVirtual ? { '--vtop': `${virtualRows.topSpacer}px`, '--vbottom': `${virtualRows.bottomSpacer}px` } : null),
                    }}
                >
                    {(isVirtual ? sortedItems.slice(virtualRows.startIndex, virtualRows.endIndex) : sortedItems).map((item, i) => {
                        const index = isVirtual ? virtualRows.startIndex + i : i;
                        return (
                        <FileItem
                            key={item.path}
                            item={item}
                            index={index}
                            viewMode={viewMode}
                            isSelected={selectedPaths.has(item.path)}
                            isFocused={!!focusedItem && focusedItem.path === item.path}
                            isCut={cutPaths.has(item.path)}
                            tags={tagMap[item.path] || null}
                            onClick={onItemClick}
                            onDoubleClick={onItemDoubleClick}
                            onContextMenu={onItemContextMenu}
                            onMouseDown={onItemMouseDown}
                        />
                        );
                    })}
                </div>
            </div>
            <StatusBar itemCount={sortedItems.length} currentPath={currentPath} viewMode={viewMode} />
        </div>
    );
};

export default FileList;

