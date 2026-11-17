import React, { useSyncExternalStore } from 'react';
import { progressStore, conflictStore, cancelTransfer } from '../../services/fileOps';
import { useI18n } from '../../i18n';
import { formatFileSize } from '../../utils/formatters';
import './fileOps.css';

/** Finder-style progress panel for running copy/move jobs. */
export const ProgressPanel = () => {
    const jobs = useSyncExternalStore(progressStore.subscribe, progressStore.get);
    const { t } = useI18n();
    const entries = Object.entries(jobs);
    if (!entries.length) return null;

    return (
        <div className="fileops-progress" role="status" aria-live="polite">
            {entries.map(([jobId, job]) => {
                const total = job.totalBytes || 0;
                const done = Math.min(job.doneBytes || 0, total);
                const pct = total > 0 ? Math.round((done / total) * 100) : null;
                return (
                    <div className="fileops-job" key={jobId}>
                        <div className="fileops-job-text">
                            <div className="fileops-job-title">{job.label}</div>
                            <div className="fileops-job-detail">
                                {total > 0
                                    ? t('{done} of {total}', { done: formatFileSize(done), total: formatFileSize(total) })
                                    : t('Preparing…')}
                                {job.current ? ` — ${job.current.split('/').pop()}` : ''}
                            </div>
                            <div className="fileops-bar">
                                <div className={`fileops-bar-fill ${pct == null ? 'indeterminate' : ''}`} style={pct == null ? undefined : { width: `${pct}%` }} />
                            </div>
                        </div>
                        <button
                            type="button"
                            className="fileops-cancel"
                            onClick={() => cancelTransfer(jobId)}
                            title={t('Stop')}
                            aria-label={t('Stop')}
                        >
                            ×
                        </button>
                    </div>
                );
            })}
        </div>
    );
};

/** Asks what to do when items with the same name already exist. */
export const ConflictDialog = () => {
    const pending = useSyncExternalStore(conflictStore.subscribe, conflictStore.get);
    const { t } = useI18n();
    if (!pending) return null;

    const { names, resolve } = pending;
    const folder = pending.targetDir.split('/').filter(Boolean).pop() || '/';
    const message = names.length === 1
        ? t('An item named "{name}" already exists in "{folder}". Do you want to replace it?', { name: names[0], folder })
        : t('{count} items with the same names already exist in "{folder}".', { count: names.length, folder });

    return (
        <div className="fileops-overlay" onKeyDown={(e) => e.key === 'Escape' && resolve('cancel')}>
            <div className="fileops-dialog" role="alertdialog" aria-modal="true">
                <div className="fileops-dialog-title">{message}</div>
                {names.length > 1 && (
                    <ul className="fileops-dialog-list">
                        {names.slice(0, 6).map((n) => <li key={n}>{n}</li>)}
                        {names.length > 6 && <li>…</li>}
                    </ul>
                )}
                <div className="fileops-dialog-hint">{t('Replacing moves the existing items to the Trash.')}</div>
                <div className="fileops-dialog-buttons">
                    <button type="button" onClick={() => resolve('cancel')}>{t('Stop')}</button>
                    <button type="button" onClick={() => resolve('skip')}>{t('Skip')}</button>
                    <button type="button" onClick={() => resolve('keep_both')}>{t('Keep Both')}</button>
                    <button type="button" className="primary" autoFocus onClick={() => resolve('replace')}>{t('Replace')}</button>
                </div>
            </div>
        </div>
    );
};
