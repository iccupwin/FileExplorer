import React from 'react';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { formatFileSize } from '../../utils/formatters';
import useSortFilter, { sortFilterActions, ICON_SIZE_MIN, ICON_SIZE_MAX } from '../../hooks/useSortFilter';
import { useI18n } from '../../i18n';
import './statusBar.css';

/** Volume containing `path` (longest matching mount point). */
const volumeFor = (volumes, path) => {
    if (!path || !Array.isArray(volumes)) return null;
    return volumes
        .filter((v) => v.mount_point && (path === v.mount_point || path.startsWith(v.mount_point.endsWith('/') ? v.mount_point : v.mount_point + '/')))
        .sort((a, b) => b.mount_point.length - a.mount_point.length)[0] || null;
};

/**
 * Finder-style status bar: item count, selection and free space,
 * plus the icon size slider in icon view.
 */
const StatusBar = ({ itemCount, currentPath, viewMode }) => {
    const { selectedItems, volumes } = useFileSystem();
    const { iconSize } = useSortFilter();
    const { t, plural, PLURALS } = useI18n();

    const volume = volumeFor(volumes, currentPath);
    const parts = [];
    parts.push(plural(itemCount, PLURALS.items));
    if (selectedItems.length > 0) {
        const selectedBytes = selectedItems.reduce((sum, i) => sum + (i.isDirectory || 'sub_file_count' in i ? 0 : i.size_in_bytes || 0), 0);
        parts.push(`${plural(selectedItems.length, PLURALS.selected)}${selectedBytes > 0 ? ` (${formatFileSize(selectedBytes)})` : ''}`);
    }
    if (volume && typeof volume.available_space === 'number') {
        parts.push(t('{size} available', { size: formatFileSize(volume.available_space) }));
    }

    return (
        <div className="status-bar">
            <span className="status-bar-text">{parts.join(', ')}</span>
            {viewMode === 'grid' && (
                <label className="status-bar-zoom" title={t('Icon size (⌘+ / ⌘−)')}>
                    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
                    <input
                        type="range"
                        min={ICON_SIZE_MIN}
                        max={ICON_SIZE_MAX}
                        step={8}
                        value={iconSize}
                        onChange={(e) => sortFilterActions.setIconSize(e.target.value)}
                        aria-label={t('Icon size')}
                    />
                    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
                </label>
            )}
        </div>
    );
};

export default StatusBar;
