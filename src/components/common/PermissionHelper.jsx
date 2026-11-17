import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import Modal from './Modal';
import Button from './Button';
import { showSuccess, showError } from '../../utils/NotificationSystem';
import { useI18n } from '../../i18n';

/**
 * PermissionHelper - Component to help users grant necessary permissions or browse to folder
 */
const PermissionHelper = ({ isOpen, onClose, directoryPath, directoryName, onDirectorySelected }) => {
    const [isChecking, setIsChecking] = useState(false);
    const [hasAccess, setHasAccess] = useState(false);
    const [isBrowsing, setIsBrowsing] = useState(false);
    const { t } = useI18n();
    // Display name of the folder (e.g. "Desktop" -> "Рабочий стол")
    const displayName = t(directoryName);

    // Check if we have access to the directory
    const checkAccess = async () => {
        if (!directoryPath) return;
        
        setIsChecking(true);
        try {
            const hasAccess = await invoke('check_directory_access', { path: directoryPath });
            setHasAccess(hasAccess);
            if (hasAccess) {
                showSuccess(t('Access granted to {name}!', { name: displayName }));
                setTimeout(onClose, 1000); // Close modal after success
            }
        } catch (error) {
            setHasAccess(false);
            console.log('Access check failed:', error);
        } finally {
            setIsChecking(false);
        }
    };

    // Auto-check when modal opens
    useEffect(() => {
        if (isOpen && directoryPath) {
            checkAccess();
        }
    }, [isOpen, directoryPath]);

    const handleGrantAccess = async () => {
        try {
            await invoke('request_full_disk_access');
        } catch (error) {
            console.error('Failed to open System Preferences:', error);
            showError(t('Unable to open System Preferences. Please open it manually.'));
        }
    };

    const handleTryAgain = () => {
        checkAccess();
    };

    const handleBrowseToFolder = async () => {
        setIsBrowsing(true);
        try {
            // Try to open the specific directory path first
            let selectedPath = null;
            
            // Try to open folder picker starting from the parent directory
            const parentPath = directoryPath ? directoryPath.substring(0, directoryPath.lastIndexOf('/')) : null;
            
            selectedPath = await open({
                directory: true,
                title: t('Browse to your {name} folder', { name: displayName }),
                defaultPath: parentPath || undefined
            });
            
            if (selectedPath) {
                showSuccess(t('Selected {name} folder: {path}', { name: displayName, path: selectedPath }));
                onDirectorySelected && onDirectorySelected(selectedPath);
                onClose();
            }
        } catch (error) {
            console.error('Failed to open folder picker:', error);
            showError(t('Failed to open folder picker. Please try again.'));
        } finally {
            setIsBrowsing(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t('Access Required: {name}', { name: displayName })}
            size="md"
            footer={
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                    <Button variant="ghost" onClick={onClose}>
                        {t('Cancel')}
                    </Button>
                    {hasAccess ? (
                        <Button variant="success" onClick={onClose}>
                            <span className="icon icon-check"></span>
                            {t('Access Granted')}
                        </Button>
                    ) : (
                        <>
                            <Button variant="ghost" onClick={handleBrowseToFolder} disabled={isBrowsing}>
                                {isBrowsing ? t('Opening...') : t('Browse to Folder')}
                            </Button>
                            <Button variant="secondary" onClick={handleTryAgain} disabled={isChecking}>
                                {isChecking ? t('Checking...') : t('Try Again')}
                            </Button>
                            <Button variant="primary" onClick={handleGrantAccess}>
                                {t('Grant Permission')}
                            </Button>
                        </>
                    )}
                </div>
            }
        >
            <div className="permission-helper">
                <div className="permission-icon">
                    {hasAccess ? (
                        <span className="icon icon-check" style={{ color: 'var(--success)', fontSize: '48px' }}></span>
                    ) : (
                        <span className="icon icon-lock" style={{ color: 'var(--warning)', fontSize: '48px' }}></span>
                    )}
                </div>
                
                <div className="permission-content">
                    {hasAccess ? (
                        <div className="success-message">
                            <h3>{t('Access Granted!')}</h3>
                            <p>{t('You now have access to your {name} folder.', { name: displayName })}</p>
                        </div>
                    ) : (
                        <div className="permission-request">
                            <h3>{t('Permission Required')}</h3>
                            <p>
                                {t('This application needs permission to access your folder:')} <strong>{displayName}</strong>
                            </p>
                            
                            <div className="instructions">
                                <h4>{t('Options to access your {name} folder:', { name: displayName })}</h4>
                                <div className="option-section">
                                    <h5>{t('Option 1: Browse to folder (Recommended)')}</h5>
                                    <p>{t('Click "Browse to Folder" to manually select your {name} directory using the system folder picker.', { name: displayName })}</p>
                                </div>
                                <div className="option-section">
                                    <h5>{t('Option 2: Grant system permission')}</h5>
                                    <ol>
                                        <li>{t('Click "Grant Permission" to open System Preferences')}</li>
                                        <li>{t('Go to')} <strong>{t('Privacy & Security → Files and Folders')}</strong></li>
                                        <li>{t('Find "Explr" in the list and enable access to "{name}"', { name: displayName })}</li>
                                        <li>{t('Return to this app and click "Try Again"')}</li>
                                    </ol>
                                </div>
                            </div>
                            
                            <div className="help-note">
                                <p><strong>{t('Note:')}</strong> {t('This is a macOS security feature that protects your personal files. Granting access allows this file explorer to browse your {name} folder.', { name: displayName })}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            
            <style jsx>{`
                .permission-helper {
                    text-align: center;
                    padding: 20px 0;
                }
                
                .permission-icon {
                    margin-bottom: 24px;
                }
                
                .permission-content {
                    text-align: left;
                }
                
                .permission-content h3 {
                    color: var(--text-primary);
                    margin: 0 0 16px 0;
                    font-size: 1.4rem;
                    font-weight: 600;
                }
                
                .permission-content p {
                    color: var(--text-secondary);
                    line-height: 1.6;
                    margin: 0 0 16px 0;
                }
                
                .instructions {
                    background: var(--surface);
                    border: 1px solid var(--border);
                    border-radius: 8px;
                    padding: 20px;
                    margin: 20px 0;
                }
                
                .instructions h4 {
                    color: var(--text-primary);
                    margin: 0 0 12px 0;
                    font-size: 1.1rem;
                    font-weight: 600;
                }
                
                .instructions ol {
                    margin: 0;
                    padding-left: 20px;
                    color: var(--text-primary);
                }
                
                .instructions li {
                    margin: 8px 0;
                    line-height: 1.5;
                }
                
                .option-section {
                    margin: 16px 0;
                    padding: 16px;
                    background: var(--background);
                    border-radius: 6px;
                    border: 1px solid var(--border);
                }
                
                .option-section h5 {
                    color: var(--text-primary);
                    margin: 0 0 8px 0;
                    font-size: 1rem;
                    font-weight: 600;
                }
                
                .option-section p {
                    color: var(--text-secondary);
                    margin: 0 0 8px 0;
                    font-size: 0.9rem;
                }
                
                .help-note {
                    background: var(--info-bg, #e3f2fd);
                    border: 1px solid var(--info-border, #90caf9);
                    border-radius: 6px;
                    padding: 16px;
                    margin-top: 20px;
                }
                
                .help-note p {
                    margin: 0;
                    color: var(--info, #1565c0);
                    font-size: 0.9rem;
                }
                
                .success-message {
                    text-align: center;
                }
                
                .success-message h3 {
                    color: var(--success);
                }
            `}</style>
        </Modal>
    );
};

export default PermissionHelper;