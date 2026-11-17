import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useHistory } from '../../providers/HistoryProvider';
import { useContextMenu } from '../../providers/ContextMenuProvider';
import useSortFilter, { applySortFilter, sortFilterActions } from '../../hooks/useSortFilter';
import { beginDragGesture } from '../../hooks/useFileDragDrop';
import { formatFileSize, formatDate, getFileType } from '../../utils/formatters';
import FileIcon from './FileIcon';
import Thumbnail, { getThumbnailKind } from './Thumbnail';
import StatusBar from './StatusBar';
import { useI18n } from '../../i18n';
import './columnView.css';

const isDir = (item) => !!(item && (item.isDirectory || 'sub_file_count' in item));

/** Folders from the column root down to `path` ("/Users/a", "/Users/a/Docs", ...). */
const columnPaths = (path) => {
    if (!path || !path.startsWith('/')) return [];
    const home = path.match(/^\/Users\/[^/]+/)?.[0];
    const root = home && (path === home || path.startsWith(home + '/')) ? home : '/';
    const rest = path.slice(root === '/' ? 1 : root.length).split('/').filter(Boolean);
    const paths = [root];
    let acc = root === '/' ? '' : root;
    for (const part of rest) {
        acc = `${acc}/${part}`;
        paths.push(acc);
    }
    return paths;
};

const toItems = (data) => [
    ...(data?.directories || []).map((d) => ({ ...d, isDirectory: true })),
    ...(data?.files || []).map((f) => ({ ...f, isDirectory: false })),
];

/** Large preview of the selected file, like Finder's last column. */
const Preview = ({ item }) => {
    const { t } = useI18n();
    const kind = getThumbnailKind(item, false);
    return (
        <div className="column-preview">
            <div className="column-preview-image">
                {kind ? (
                    <Thumbnail item={item} kind={kind} fallback={<FileIcon filename={item.name} isDirectory={false} path={item.path} iconSize={256} />} />
                ) : (
                    <FileIcon filename={item.name} isDirectory={false} path={item.path} iconSize={256} />
                )}
            </div>
            <div className="column-preview-name">{item.name}</div>
            <div className="column-preview-kind">{getFileType(item.name)} — {formatFileSize(item.size_in_bytes)}</div>
            <dl className="column-preview-meta">
                <dt>{t('Created')}</dt><dd>{formatDate(item.created, true)}</dd>
                <dt>{t('Modified')}</dt><dd>{formatDate(item.last_modified, true)}</dd>
                {item.date_added && (<><dt>{t('Added')}</dt><dd>{formatDate(item.date_added, true)}</dd></>)}
            </dl>
        </div>
    );
};

/**
 * Finder-style column (Miller) view.
 */
const ColumnView = () => {
    const { currentDirData, loadDirectory, openFile, selectedItems, selectMultiple, setFocusedItem, volumes } = useFileSystem();
    const { currentPath } = useHistory();
    const { openContextMenu } = useContextMenu();
    const sortFilter = useSortFilter();
    const [ancestorData, setAncestorData] = useState({}); // path -> listing
    const scrollRef = useRef(null);

    const paths = useMemo(() => columnPaths(currentPath), [currentPath]);

    // Load the parent columns (the last column is the open folder itself)
    useEffect(() => {
        let cancelled = false;
        const missing = paths.slice(0, -1).filter((p) => !ancestorData[p]);
        if (!missing.length) return;
        Promise.all(
            missing.map((p) =>
                invoke('open_directory', { path: p })
                    .then((json) => [p, JSON.parse(json)])
                    .catch(() => [p, { directories: [], files: [] }])
            )
        ).then((entries) => {
            if (cancelled) return;
            setAncestorData((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
        });
        return () => { cancelled = true; };
    }, [paths]); // eslint-disable-line react-hooks/exhaustive-deps

    const columns = paths.map((p, i) => {
        const isLast = i === paths.length - 1;
        const data = isLast ? currentDirData : ancestorData[p];
        // Filters apply to the open folder only, so the path stays visible
        const settings = isLast ? sortFilter : { ...sortFilter, kindFilter: 'all', dateFilter: 'any' };
        return { path: p, items: applySortFilter(toItems(data), settings), childOnPath: paths[i + 1] };
    });
    const lastItems = columns.length ? columns[columns.length - 1].items : [];
    const selectedFile = selectedItems.length === 1 && !isDir(selectedItems[0]) ? selectedItems[0] : null;

    // Keep the newest column in view
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
    }, [paths.length, selectedFile?.path]);

    const select = (item) => {
        selectMultiple([item]);
        setFocusedItem(item);
    };

    const activate = (item, colIndex) => {
        if (isDir(item)) {
            loadDirectory(item.path);
        } else if (colIndex === columns.length - 1) {
            select(item);
        } else {
            // A file in a parent column: open its folder, then select it
            loadDirectory(columns[colIndex].path).then(() => select(item));
        }
    };

    // Keyboard: up/down in the open folder, left = parent, right/enter = open
    useEffect(() => {
        const onKeyDown = (e) => {
            const t = e.target;
            if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const current = selectedItems[0];
            const idx = current ? lastItems.findIndex((i) => i.path === current.path) : -1;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!lastItems.length) return;
                const next = idx === -1 ? 0 : Math.max(0, Math.min(lastItems.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
                select(lastItems[next]);
                document.querySelector(`.column-view [data-path="${CSS.escape(lastItems[next].path)}"]`)?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (paths.length > 1) {
                    const from = currentPath;
                    loadDirectory(paths[paths.length - 2]).then(() => {
                        const parentItem = (ancestorData[paths[paths.length - 2]] && toItems(ancestorData[paths[paths.length - 2]]).find((i) => i.path === from)) || null;
                        if (parentItem) select(parentItem);
                    });
                }
            } else if (e.key === 'ArrowRight' && current && isDir(current)) {
                e.preventDefault();
                loadDirectory(current.path);
            } else if (e.key === 'Enter' && current) {
                // Return renames, like Finder
                e.preventDefault();
                document.dispatchEvent(new CustomEvent('open-rename-modal', { detail: { item: current } }));
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    });

    return (
        <div className="file-list-wrapper">
            <div className="column-view file-list-container" ref={scrollRef}>
                {columns.map((col, colIndex) => (
                    <div className="column" key={col.path}>
                        {col.items.map((item) => {
                            const onPath = item.path === col.childOnPath;
                            const selected = colIndex === columns.length - 1 && selectedItems.some((s) => s.path === item.path);
                            return (
                                <div
                                    key={item.path}
                                    data-path={item.path}
                                    className={`column-item file-item ${isDir(item) ? 'directory' : 'file'} ${selected ? 'selected' : ''} ${onPath ? 'on-path' : ''}`}
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        beginDragGesture(e, () => {
                                            const inSel = selectedItems.some((s) => s.path === item.path);
                                            const dragged = inSel ? selectedItems : [item];
                                            return { paths: dragged.map((d) => d.path), isDirectory: dragged.length === 1 && isDir(dragged[0]) };
                                        });
                                    }}
                                    onClick={() => activate(item, colIndex)}
                                    onDoubleClick={() => !isDir(item) && openFile(item.path)}
                                    onContextMenu={(e) => { e.preventDefault(); select(item); openContextMenu(e, item); }}
                                    title={item.name}
                                >
                                    <span className="column-item-icon">
                                        <FileIcon filename={item.name} isDirectory={isDir(item)} path={item.path} iconSize={32} />
                                    </span>
                                    <span className="column-item-name">{item.name}</span>
                                    {isDir(item) && <span className="column-item-chevron" aria-hidden="true">›</span>}
                                </div>
                            );
                        })}
                    </div>
                ))}
                {selectedFile && (
                    <div className="column column-preview-column">
                        <Preview item={selectedFile} />
                    </div>
                )}
            </div>
            <StatusBar itemCount={lastItems.length} currentPath={currentPath} viewMode="columns" />
        </div>
    );
};

export default ColumnView;
