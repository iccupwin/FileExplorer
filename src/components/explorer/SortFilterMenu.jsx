import React, { useEffect, useRef, useState } from 'react';
import useSortFilter, {
    SORT_OPTIONS,
    KIND_FILTERS,
    DATE_FILTERS,
    isFilterActive,
    sortFilterActions,
} from '../../hooks/useSortFilter';
import { useI18n } from '../../i18n';
import './sortFilterMenu.css';

const Check = ({ visible }) => (
    <span className="sf-check" aria-hidden="true">
        {visible && (
            <svg viewBox="0 0 16 16" width="12" height="12">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        )}
    </span>
);

const SortIcon = () => (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path d="M6 4v12M6 16l-3-3M6 16l3-3M14 16V4M14 4l-3 3M14 4l3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

const FilterIcon = () => (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path d="M3 5h14M6 10h8M8.5 15h3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
);

const Chevron = () => (
    <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
        <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

/**
 * Dropdown that closes on outside click and Escape.
 */
const Dropdown = ({ button, children, align = 'right' }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [open]);

    return (
        <div className="sf-dropdown" ref={ref}>
            {button({ open, toggle: () => setOpen((v) => !v) })}
            {open && (
                <div className={`sf-menu sf-menu-${align}`} role="menu" onClick={(e) => e.stopPropagation()}>
                    {children(() => setOpen(false))}
                </div>
            )}
        </div>
    );
};

const MenuItem = ({ checked, onClick, children }) => (
    <button type="button" role="menuitemcheckbox" aria-checked={!!checked} className="sf-item" onClick={onClick}>
        <Check visible={checked} />
        <span className="sf-item-label">{children}</span>
    </button>
);

/**
 * Finder-style "Sort By" and filter menus for the toolbar.
 */
const SortFilterMenu = () => {
    const sf = useSortFilter();
    const { t } = useI18n();
    const currentSort = SORT_OPTIONS.find((o) => o.key === sf.sortKey) || SORT_OPTIONS[0];
    const filterActive = isFilterActive(sf);
    const activeFilterCount = (sf.kindFilter !== 'all' ? 1 : 0) + (sf.dateFilter !== 'any' ? 1 : 0);

    return (
        <div className="sort-filter-menu">
            <Dropdown
                button={({ open, toggle }) => (
                    <button
                        type="button"
                        className={`sf-button ${open ? 'open' : ''}`}
                        onClick={toggle}
                        title={t('Sort items')}
                        aria-haspopup="menu"
                        aria-expanded={open}
                    >
                        <SortIcon />
                        <span className="sf-button-label">{t(currentSort.label)}</span>
                        <Chevron />
                    </button>
                )}
            >
                {(close) => (
                    <>
                        <div className="sf-heading">{t('Sort By')}</div>
                        {SORT_OPTIONS.map((option) => (
                            <MenuItem
                                key={option.key}
                                checked={sf.sortKey === option.key}
                                onClick={() => {
                                    if (sf.sortKey !== option.key) sortFilterActions.sortBy(option.key);
                                    close();
                                }}
                            >
                                {t(option.label)}
                            </MenuItem>
                        ))}
                        <div className="sf-separator" />
                        <MenuItem checked={sf.direction === 'asc'} onClick={() => sortFilterActions.setDirection('asc')}>
                            {sf.sortKey === 'name' || sf.sortKey === 'kind' ? t('A → Z') : sf.sortKey === 'size' ? t('Smallest First') : t('Oldest First')}
                        </MenuItem>
                        <MenuItem checked={sf.direction === 'desc'} onClick={() => sortFilterActions.setDirection('desc')}>
                            {sf.sortKey === 'name' || sf.sortKey === 'kind' ? t('Z → A') : sf.sortKey === 'size' ? t('Largest First') : t('Newest First')}
                        </MenuItem>
                        <div className="sf-separator" />
                        <MenuItem checked={sf.foldersFirst} onClick={() => sortFilterActions.toggleFoldersFirst()}>
                            {t('Keep Folders on Top')}
                        </MenuItem>
                    </>
                )}
            </Dropdown>

            <Dropdown
                button={({ open, toggle }) => (
                    <button
                        type="button"
                        className={`sf-button sf-button-icon ${open ? 'open' : ''} ${filterActive ? 'active' : ''}`}
                        onClick={toggle}
                        title={t('Filter items')}
                        aria-haspopup="menu"
                        aria-expanded={open}
                    >
                        <FilterIcon />
                        {filterActive && <span className="sf-badge">{activeFilterCount}</span>}
                    </button>
                )}
            >
                {(close) => (
                    <>
                        <div className="sf-heading">{t('Kind')}</div>
                        {KIND_FILTERS.map((option) => (
                            <MenuItem
                                key={option.key}
                                checked={sf.kindFilter === option.key}
                                onClick={() => sortFilterActions.setKindFilter(option.key)}
                            >
                                {t(option.label)}
                            </MenuItem>
                        ))}
                        <div className="sf-separator" />
                        <div className="sf-heading">{t('Date Added')}</div>
                        {DATE_FILTERS.map((option) => (
                            <MenuItem
                                key={option.key}
                                checked={sf.dateFilter === option.key}
                                onClick={() => sortFilterActions.setDateFilter(option.key)}
                            >
                                {t(option.label)}
                            </MenuItem>
                        ))}
                        {filterActive && (
                            <>
                                <div className="sf-separator" />
                                <button
                                    type="button"
                                    className="sf-item sf-item-clear"
                                    onClick={() => {
                                        sortFilterActions.clearFilters();
                                        close();
                                    }}
                                >
                                    <span className="sf-check" />
                                    <span className="sf-item-label">{t('Clear Filter')}</span>
                                </button>
                            </>
                        )}
                    </>
                )}
            </Dropdown>
        </div>
    );
};

export default SortFilterMenu;
