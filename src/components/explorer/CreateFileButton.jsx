import React, { useState, useRef, useEffect } from 'react';
import { useFileSystem } from '../../providers/FileSystemProvider';
import { useHistory } from '../../providers/HistoryProvider';
import Modal from '../common/Modal';
import Button from '../common/Button';
import { useI18n } from '../../i18n';
import './createFileButton.css';

/**
 * Component for creating new files and folders
 * @returns {React.ReactElement} Create file button component with dropdown
 */
const CreateFileButton = () => {
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [creationType, setCreationType] = useState(''); // 'file' or 'folder'
    const [itemName, setItemName] = useState('');
    const dropdownRef = useRef(null);
    const inputRef = useRef(null);
    const skipNextToggle = useRef(false);

    const { createFile, createDirectory } = useFileSystem();
    const { currentPath } = useHistory();
    const { t } = useI18n();

    /**
     * Sets up event listeners for custom create events
     */
    useEffect(() => {
        const handleCreateFile = () => {
            handleOptionClick('file');
        };

        const handleCreateFolder = () => {
            handleOptionClick('folder');
        };

        document.addEventListener('create-file', handleCreateFile);
        document.addEventListener('create-folder', handleCreateFolder);

        return () => {
            document.removeEventListener('create-file', handleCreateFile);
            document.removeEventListener('create-folder', handleCreateFolder);
        };
    }, []);

    /**
     * Toggles the dropdown menu
     */
    // Prevent immediate reopen after closing
    const toggleDropdown = () => {
        if (skipNextToggle.current) {
            skipNextToggle.current = false;
            return;
        }
        setIsDropdownOpen(prev => !prev);
    };

    /**
     * Closes the dropdown menu
     */
    const closeDropdown = () => {
        setIsDropdownOpen(false);
        skipNextToggle.current = true;
    };

    /**
     * Handles clicking an option in the dropdown
     * @param {string} type - The type of item to create ('file' or 'folder')
     */
    const handleOptionClick = (type) => {
        setCreationType(type);
        setItemName(getDefaultName(type));
        setIsCreateModalOpen(true);
        closeDropdown();
        skipNextToggle.current = false;

        // Focus input on next render
        setTimeout(() => {
            if (inputRef.current) {
                inputRef.current.focus();
                inputRef.current.select();
            }
        }, 0);
    };

    /**
     * Gets default name for new items
     * @param {string} type - The type of item ('file' or 'folder')
     * @returns {string} Default name for the item
     */
    const getDefaultName = (type) => {
        return type === 'file' ? t('New File.txt') : t('New Folder');
    };

    /**
     * Handles input field changes
     * @param {React.ChangeEvent<HTMLInputElement>} e - The change event
     */
    const handleNameChange = (e) => {
        setItemName(e.target.value);
    };

    /**
     * Handles creating the file or folder
     */
    const handleCreate = async () => {
        if (!itemName.trim()) return;

        try {
            if (creationType === 'file') {
                await createFile(currentPath, itemName);
            } else if (creationType === 'folder') {
                await createDirectory(currentPath, itemName);
            }

            setIsCreateModalOpen(false);
            setItemName('');
        } catch (error) {
            console.error('Failed to create item:', error);

            // Check for specific error types
            if (error.message && error.message.includes('already exists')) {
                const shouldCreateCopy = confirm(
                    t('An item named "{name}" already exists. Would you like to create a copy instead?', { name: itemName })
                );

                if (shouldCreateCopy) {
                    const extension = itemName.includes('.') ? '.' + itemName.split('.').pop() : '';
                    const baseName = extension ? itemName.replace(extension, '') : itemName;
                    const copyName = `${baseName} - Copy${extension}`;
                    setItemName(copyName);
                    return; // Don't close modal, let user try again
                }
            } else {
                alert(creationType === 'file'
                    ? t('Failed to create file: {error}', { error: error.message || error })
                    : t('Failed to create folder: {error}', { error: error.message || error }));
            }
        }
    };

    /**
     * Handles form submission
     * @param {React.FormEvent} e - The form event
     */
    const handleSubmit = (e) => {
        e.preventDefault();
        handleCreate();
    };

    /**
     * Sets up click outside detection to close dropdown
     */
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (
                dropdownRef.current &&
                !dropdownRef.current.contains(event.target)
            ) {
                closeDropdown();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);

    return (
        <>
            <div className="create-file-container">
                <button
                    className="create-button"
                    onClick={toggleDropdown}
                    aria-label={t('Create new item')}
                    aria-expanded={isDropdownOpen}
                    aria-haspopup="true"
                >
                    <span className="icon icon-plus"></span>
                    <span>{t('New')}</span>
                    <span className="icon icon-chevron-down"></span>
                </button>

                {isDropdownOpen && (
                    <div className="create-dropdown" ref={dropdownRef}>
                        <ul className="create-options">
                            <li>
                                <button
                                    className="create-option"
                                    onClick={() => handleOptionClick('file')}
                                >
                                    <span className="icon icon-file"></span>
                                    <span>{t('Text File')}</span>
                                    <span className="shortcut">Ctrl+N</span>
                                </button>
                            </li>
                            <li>
                                <button
                                    className="create-option"
                                    onClick={() => handleOptionClick('folder')}
                                >
                                    <span className="icon icon-folder"></span>
                                    <span>{t('Folder')}</span>
                                    <span className="shortcut">Ctrl+Shift+N</span>
                                </button>
                            </li>
                            <li className="create-divider"></li>
                            <li>
                                <button
                                    className="create-option"
                                    onClick={() => {
                                        document.dispatchEvent(new CustomEvent('open-templates'));
                                        closeDropdown();
                                        skipNextToggle.current = false;
                                    }}
                                >
                                    <span className="icon icon-template"></span>
                                    <span>{t('From Template...')}</span>
                                </button>
                            </li>
                        </ul>
                    </div>
                )}
            </div>

            <Modal
                isOpen={isCreateModalOpen}
                onClose={() => setIsCreateModalOpen(false)}
                title={creationType === 'file' ? t('Create New File') : t('Create New Folder')}
                size="sm"
                footer={
                    <>
                        <Button
                            variant="ghost"
                            onClick={() => setIsCreateModalOpen(false)}
                        >
                            {t('Cancel')}
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            disabled={!itemName.trim()}
                            onClick={handleCreate}
                        >
                            {t('Create')}
                        </Button>
                    </>
                }
            >
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="item-name">
                            {creationType === 'file' ? t('File name:') : t('Folder name:')}
                        </label>
                        <input
                            ref={inputRef}
                            type="text"
                            id="item-name"
                            value={itemName}
                            onChange={handleNameChange}
                            className="input"
                            placeholder={creationType === 'file' ? t('Enter file name') : t('Enter folder name')}
                        />
                        <div className="input-hint">
                            {creationType === 'file'
                                ? t('Include the file extension (e.g., .txt, .md, .json)')
                                : t('Choose a descriptive name for your folder')
                            }
                        </div>
                    </div>
                </form>
            </Modal>
        </>
    );
};

export default CreateFileButton;