import React, { useEffect } from 'react';
import FileList from '../explorer/FileList';
import EmptyState from '../explorer/EmptyState';
import useSearch from '../../hooks/useSearch';
import { formatFileSize, formatDate } from '../../utils/formatters';
import { useI18n } from '../../i18n';
import './searchResults.css';

/**
 * SearchResults component - Displays search results from the useSearch hook
 *
 * @param {Object} props - Component props
 * @param {string} props.query - The search query string
 * @param {string} props.viewMode - The current view mode (grid, list, details)
 * @param {Function} props.onClearSearch - Callback function to clear the search
 * @returns {React.ReactElement} SearchResults component
 */
const SearchResults = ({ query, viewMode, onClearSearch }) => {
    const { t, plural } = useI18n();
    const {
        results,
        isSearching,
        error,
        updateQuery,
        performSearch,
        options
    } = useSearch();

    /**
     * Effect to perform search when query changes
     */
    useEffect(() => {
        if (query) {
            updateQuery(query);
            performSearch();
        }
    }, [query, updateQuery, performSearch]);

    // If loading
    if (isSearching) {
        return (
            <div className="search-results-container">
                <div className="search-header">
                    <h2 className="search-title">
                        {t('Searching for "{query}"', { query })}
                    </h2>
                    <div className="search-progress">
                        <div className="progress progress-indeterminate">
                            <div className="progress-bar"></div>
                        </div>
                        <p className="search-info">{t('Searching in {location}…', { location: options.searchIn || t('current location') })}</p>
                    </div>
                </div>

                <div className="search-loading">
                    <div className="spinner"></div>
                </div>
            </div>
        );
    }

    // If error
    if (error) {
        return (
            <div className="search-results-container">
                <div className="search-header">
                    <h2 className="search-title">
                        {t('Search error')}
                    </h2>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={onClearSearch}
                    >
                        {t('Clear search')}
                    </button>
                </div>

                <div className="alert alert-error">
                    <div className="alert-icon">
                        <span className="icon icon-alert-circle"></span>
                    </div>
                    <div className="alert-content">
                        <div className="alert-title">{t('Search failed')}</div>
                        <p className="alert-message">{t(error)}</p>
                    </div>
                </div>
            </div>
        );
    }

    // If no results yet or empty query
    if (!results) {
        return null;
    }

    // If no files or directories found
    if (results.files.length === 0 && results.directories.length === 0) {
        return (
            <div className="search-results-container">
                <div className="search-header">
                    <h2 className="search-title">
                        {t('Search results for "{query}"', { query })}
                    </h2>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={onClearSearch}
                    >
                        {t('Clear search')}
                    </button>
                </div>

                <EmptyState
                    type="no-results"
                    searchTerm={query}
                />
            </div>
        );
    }

    // Total results count
    const totalResults = results.files.length + results.directories.length;

    return (
        <div className="search-results-container">
            <div className="search-header">
                <h2 className="search-title">
                    {t('Search results for "{query}"', { query })}
                </h2>
                <div className="search-controls">
                  <span className="search-count">
                    {plural(totalResults, { en: ['{count} result found', '{count} results found'], ru: ['Найден {count} результат', 'Найдено {count} результата', 'Найдено {count} результатов'] })}
                  </span>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={onClearSearch}
                    >
                        {t('Clear search')}
                    </button>
                </div>
            </div>

            {/* Search filter tags (optional) */}
            <div className="search-filters">
                {options.caseSensitive && (
                    <span className="search-filter">{t('Case sensitive')}</span>
                )}
                {options.matchWholeWord && (
                    <span className="search-filter">{t('Whole word')}</span>
                )}
                {options.fileTypes.length > 0 && (
                    <span className="search-filter">
                      {t('Type: {types}', { types: options.fileTypes.join(', ') })}
                    </span>
                )}
            </div>

            {/* Results */}
            <FileList
                data={results}
                isLoading={false}
                viewMode={viewMode}
                isSearching={true}
            />
        </div>
    );
};

export default SearchResults;