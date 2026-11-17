import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import FileIcon from './FileIcon';
import { formatFileSize, formatDate, getFileType } from '../../utils/formatters';
import { useI18n, PLURALS } from '../../i18n';
import './detailsPanel.css';

/**
 * Component that displays detailed information about a selected item
 * @param {Object} props - Component properties
 * @param {Object} [props.item] - The selected item to display details for
 * @param {boolean} [props.isMultipleSelection=false] - Whether multiple items are selected
 * @returns {React.ReactElement} Details panel component
 */
const DetailsPanel = ({ item, isMultipleSelection = false }) => {
    // Folder contents are counted on demand (listings no longer read subfolders)
    const folderPath = item && !isMultipleSelection && (item.isDirectory || 'sub_file_count' in item) ? item.path : null;
    const [counts, setCounts] = useState(null);
    const { t, plural, language } = useI18n();
    useEffect(() => {
        setCounts(null);
        if (!folderPath || folderPath.startsWith('sftp:')) return;
        let cancelled = false;
        invoke('count_directory_entries', { path: folderPath })
            .then(([files, folders]) => { if (!cancelled) setCounts({ files, folders }); })
            .catch(() => { if (!cancelled) setCounts({ error: true }); });
        return () => { cancelled = true; };
    }, [folderPath]);

    // If no item selected or multiple items are selected
    if (!item || isMultipleSelection) {
        return (
            <div className="details-panel">
                <div className="details-header">
                    <h3 className="details-title">
                        {isMultipleSelection
                            ? t('Multiple Items Selected')
                            : t('No Item Selected')}
                    </h3>
                </div>

                <div className="details-content">
                    {isMultipleSelection ? (
                        <div className="details-summary">
                            {/* In a real implementation, this would show the count of files and folders,
              total size, etc. */}
                            <p>{t('Multiple items selected. Select a single item to view details.')}</p>
                        </div>
                    ) : (
                        <div className="details-empty">
                            <p>{t('Select an item to view its details.')}</p>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // Determine if item is a directory or file
    const isDirectory = item.isDirectory || 'sub_file_count' in item;

    // Format size
    const size = isDirectory
        ? (counts == null ? t('Counting…') : counts.error ? '—' : `${plural(counts.files, PLURALS.files)}, ${plural(counts.folders, PLURALS.folders)}`)
        : formatFileSize(item.size_in_bytes);

    // Get file type
    const fileType = isDirectory ? t('Folder') : getFileType(item.name);

    // Get extension (for files)
    const extension = !isDirectory && item.name.includes('.')
        ? item.name.split('.').pop().toUpperCase()
        : '';

    // Format dates
    const created = formatDate(item.created, true);
    const modified = formatDate(item.last_modified, true);
    const accessed = formatDate(item.accessed, true);

    return (
        <div className="details-panel">
            <div className="details-header">
                <h3 className="details-title">{t('Properties')}</h3>
            </div>

            <div className="details-content">
                <div className="details-preview">
                    <div className="details-icon">
                        <FileIcon
                            filename={item.name}
                            isDirectory={isDirectory}
                            size="large"
                        />
                    </div>

                    <div className="details-name truncate" title={item.name}>
                        {item.name}
                    </div>

                    <div className="details-type">
                        {fileType}{extension ? ` (${extension})` : ''}
                    </div>
                </div>

                <div className="details-section">
                    <h4 className="details-section-title">{t('General')}</h4>

                    <div className="details-row">
                        <span className="details-label">{t('Location:')}</span>
                        <span className="details-value truncate" title={item.path}>
                          {item.path.replace(`/${item.name}`, '')}
                        </span>
                    </div>

                    <div className="details-row">
                        <span className="details-label">{t('Size:')}</span>
                        <span className="details-value">
                          {size}
                            {!isDirectory && item.size_in_bytes != null && (
                                <span className="details-value-secondary"> ({t('{count} bytes', { count: item.size_in_bytes.toLocaleString(language === 'ru' ? 'ru-RU' : 'en-US') })})</span>
                            )}
                        </span>
                    </div>

                    {!isDirectory && (
                        <div className="details-row">
                            <span className="details-label">{t('Type:')}</span>
                            <span className="details-value">{fileType}</span>
                        </div>
                    )}
                </div>

                <div className="details-section">
                    <h4 className="details-section-title">{t('Dates')}</h4>

                    <div className="details-row">
                        <span className="details-label">{t('Created:')}</span>
                        <span className="details-value">{created}</span>
                    </div>

                    <div className="details-row">
                        <span className="details-label">{t('Modified:')}</span>
                        <span className="details-value">{modified}</span>
                    </div>

                    <div className="details-row">
                        <span className="details-label">{t('Accessed:')}</span>
                        <span className="details-value">{accessed}</span>
                    </div>
                </div>

                <div className="details-section">
                    <h4 className="details-section-title">{t('Permissions')}</h4>

                    <div className="details-row">
                        <span className="details-label">{t('Access rights:')}</span>
                        <span className="details-value">{item.access_rights_as_string}</span>
                    </div>

                    <div className="details-row">
                        <span className="details-label">{t('Octal:')}</span>
                        <span className="details-value">{item.access_rights_as_number}</span>
                    </div>

                    <div className="details-row">
                        <span className="details-label">{t('Symlink:')}</span>
                        <span className="details-value">{item.is_symlink ? t('Yes') : t('No')}</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DetailsPanel;

