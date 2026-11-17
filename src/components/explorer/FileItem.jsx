import React from 'react';
import FileIcon from './FileIcon';
import { formatFileSize, formatDate, getFileType } from '../../utils/formatters';
import { useI18n } from '../../i18n';
import Thumbnail, { getThumbnailKind } from './Thumbnail';
import './fileItem.css';

/**
 * Component that displays a single file or directory item
 * @param {Object} props - Component properties
 * @param {Object} props.item - The file or directory object to display
 * @param {string} [props.viewMode='grid'] - The view mode: 'grid', 'list', or 'details'
 * @param {boolean} [props.isSelected=false] - Whether the item is currently selected
 * @param {boolean} [props.isFocused=false] - Whether the item is currently focused for keyboard navigation
 * @param {Function} props.onClick - Click handler function
 * @param {Function} props.onDoubleClick - Double-click handler function
 * @param {Function} props.onContextMenu - Context menu handler function
 * @param {number} props.index - Position in the displayed list
 * @param {boolean} [props.isCut=false] - Whether the item is cut to the clipboard
 *
 * Handlers are called as handler(event, item, index) so the parent can pass
 * stable functions; together with React.memo only changed items re-render.
 * @returns {React.ReactElement} File/directory item component
 */
const FileItem = ({
                      item,
                      viewMode = 'grid',
                      isSelected = false,
                      isFocused = false,
                      onClick,
                      onDoubleClick,
                      onContextMenu,
                      onMouseDown: onItemMouseDown,
                      index = 0,
                      isCut = false,
                      tags = null
                  }) => {
    const { t } = useI18n();

    const isDirectory = item.isDirectory || 'sub_file_count' in item;
    const fileType = isDirectory ? t('Folder') : getFileType(item.name);
    // Like Finder, folders show no size in lists (counting them is slow)
    const size = isDirectory ? '—' : formatFileSize(item.size_in_bytes);

    // Finder-style thumbnails for images, PDFs and videos (grid view)
    const thumbnailKind = getThumbnailKind(item, isDirectory);

    // Format modified date
    const modified = formatDate(item.last_modified);


    /**
     * Handles click events on the file item
     * @param {React.MouseEvent} e - The click event
     */
    const handleClick = (e) => {
        if (onClick) onClick(e, item, index);
    };

    /**
     * Handles mouse down events to prevent text selection
     * @param {React.MouseEvent} e - The mouse down event
     */
    const handleMouseDown = (e) => {
        // Prevent text selection on mouse down
        e.preventDefault();
        if (onItemMouseDown) onItemMouseDown(e, item, index);
    };

    /**
     * Handles selectstart events to prevent text selection
     * @param {React.SyntheticEvent} e - The selectstart event
     */
    const handleSelectStart = (e) => {
        // Prevent any text selection
        e.preventDefault();
        return false;
    };

    /**
     * Handles double-click events on the file item
     * @param {React.MouseEvent} e - The double-click event
     */
    const handleDoubleClick = (e) => {
        // Prevent text selection on double-click
        e.preventDefault();
        e.stopPropagation();
        
        // Clear any existing text selection
        if (window.getSelection) {
            window.getSelection().removeAllRanges();
        }
        
        if (onDoubleClick) onDoubleClick(e, item, index);
    };

    /**
     * Handles right-click context menu events on the file item
     * @param {React.MouseEvent} e - The context menu event
     */
    const handleContextMenu = (e) => {
        if (onContextMenu) onContextMenu(e);
    };

    return (
        <>
            <div
                className={`file-item view-mode-${viewMode.toLowerCase()} ${isSelected ? 'selected' : ''} ${isFocused ? 'focused' : ''} ${isDirectory ? 'directory' : 'file'} ${isCut ? 'cut' : ''}`}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onMouseDown={handleMouseDown}
                onSelectStart={handleSelectStart}
                onContextMenu={handleContextMenu}
                data-path={item.path}
            >
                {viewMode === 'grid' && (
                    <div className="file-item-grid">
                        <div className="file-icon-container">
                            {thumbnailKind ? (
                                <Thumbnail
                                    item={item}
                                    kind={thumbnailKind}
                                    fallback={<FileIcon filename={item.name} isDirectory={isDirectory} path={item.path} iconSize={128} />}
                                />
                            ) : (
                                <FileIcon filename={item.name} isDirectory={isDirectory} path={item.path} iconSize={128} />
                            )}
                        </div>

                        <div className="file-name truncate" title={item.name}>
                            {item.name}
                            {tags && tags.length > 0 && (
                                <span className="file-tags" aria-label={tags.map(tg => tg.name).join(', ')}>
                                    {tags.map(tg => <span key={`${tg.color}-${tg.name}`} className={`tag-dot tag-color-${tg.color}`} title={tg.name} />)}
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {viewMode === 'list' && (
                    <div className="file-item-list">
                        <div className="file-icon-container">
                            <FileIcon filename={item.name} isDirectory={isDirectory} path={item.path} iconSize={32} />
                        </div>

                        <div className="file-details">
                            <div className="file-name truncate" title={item.name}>
                                {item.name}
                                {tags && tags.length > 0 && (
                                    <span className="file-tags" aria-label={tags.map(tg => tg.name).join(', ')}>
                                        {tags.map(tg => <span key={`${tg.color}-${tg.name}`} className={`tag-dot tag-color-${tg.color}`} title={tg.name} />)}
                                    </span>
                                )}
                            </div>
                            <div className="file-info truncate">
                                {size} • {modified}
                            </div>
                        </div>
                    </div>
                )}

                {viewMode === 'details' && (
                    <div className="file-item-details">
                        <div className="file-column column-name">
                            <div className="file-icon-container">
                                <FileIcon filename={item.name} isDirectory={isDirectory} path={item.path} iconSize={32} />
                            </div>

                            <div className="file-name truncate" title={item.name}>
                                {item.name}
                                {tags && tags.length > 0 && (
                                    <span className="file-tags" aria-label={tags.map(tg => tg.name).join(', ')}>
                                        {tags.map(tg => <span key={`${tg.color}-${tg.name}`} className={`tag-dot tag-color-${tg.color}`} title={tg.name} />)}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="file-column column-size">
                            {size}
                        </div>

                        <div className="file-column column-type">
                            {fileType}
                        </div>

                        <div className="file-column column-modified">
                            {modified}
                        </div>
                    </div>
                )}
            </div>

        </>
    );
};

export default React.memo(FileItem);