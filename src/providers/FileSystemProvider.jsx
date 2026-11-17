import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import * as fileOps from '../services/fileOps';
import { useHistory } from './HistoryProvider';
import { useSettings } from './SettingsProvider';
import { useSftp } from './SftpProvider';
import { getDirectoryPath } from '../utils/pathUtils';
import { t } from '../i18n';

// Create file system context
const FileSystemContext = createContext({
    currentDirData: null,
    isLoading: false,
    selectedItems: [],
    focusedItem: null,
    volumes: [],
    error: null,
    loadDirectory: () => {},
    openFile: () => {},
    createFile: () => {},
    createDirectory: () => {},
    renameItem: () => {},
    moveToTrash: () => {},
    selectItem: () => {},
    selectMultiple: () => {},
    clearSelection: () => {},
    setFocusedItem: () => {},
    zipItems: () => {},
    unzipItem: () => {},
    loadVolumes: () => {},
});

export default function FileSystemProvider({ children }) {
    const [currentDirData, setCurrentDirData] = useState(null);
    const [isLoading, setIsLoading] = useState(true); // Starten Sie mit isLoading=true
    const [selectedItems, setSelectedItems] = useState([]);
    const [focusedItem, setFocusedItem] = useState(null);
    const [volumes, setVolumes] = useState([]);
    const [error, setError] = useState(null);
    const { navigateTo, currentPath } = useHistory();
    // Path whose contents are currently shown; prevents loading the same folder twice
    const lastLoadedPathRef = useRef(null);
    const { settings } = useSettings();
    const { 
        isSftpPath, 
        loadSftpDirectory, 
        createSftpFile, 
        createSftpDirectory, 
        deleteSftpItem, 
        renameSftpItem, 
        downloadAndOpenSftpFile 
    } = useSftp();

    // Helper function to check if a file or directory is hidden
    const isHiddenItem = useCallback((name) => {
        // Files/folders starting with a dot are considered hidden on Unix-like systems
        return name.startsWith('.');
    }, []);

    // Helper function to filter directory data based on hidden files setting
    const filterDirectoryData = useCallback((dirData) => {
        if (!dirData) return dirData;
        
        // If show_hidden_files_and_folders is true, return data as-is
        if (settings.show_hidden_files_and_folders) {
            return dirData;
        }

        // Filter out hidden files and directories
        const filteredDirectories = dirData.directories ? 
            dirData.directories.filter(dir => !isHiddenItem(dir.name)) : [];
        const filteredFiles = dirData.files ? 
            dirData.files.filter(file => !isHiddenItem(file.name)) : [];

        return {
            ...dirData,
            directories: filteredDirectories,
            files: filteredFiles
        };
    }, [settings.show_hidden_files_and_folders, isHiddenItem]);

    // Load system volumes information
    const loadVolumes = useCallback(async () => {
        try {
            const volumesJson = await invoke('get_system_volumes_information_as_json');
            const volumesData = JSON.parse(volumesJson);
            setVolumes(volumesData);
            return volumesData; // Zurückgeben zur weiteren Verwendung
        } catch (err) {
            console.error('Failed to load volumes:', err);
            setError(t('Failed to load volumes: {error}', { error: err.message || err }));
            // No fake volumes: show an empty list instead of a non-existent "C:\\" disk
            setVolumes([]);
            return [];
        }
    }, []);

    // Load directory contents - enhanced with SFTP support
    const loadDirectory = useCallback(async (path) => {
        if (!path) {
            console.error("Cannot load directory: path is empty");
            setIsLoading(false);
            return false;
        }

        console.log(`Attempting to load directory: ${path}`);
        setIsLoading(true);
        setError(null);

        try {
            // Check if it's an SFTP path
            if (isSftpPath(path)) {
                console.log(`Loading SFTP directory: ${path}`);
                const sftpData = await loadSftpDirectory(path);
                if (sftpData) {
                    const filteredData = filterDirectoryData(sftpData);
                    setCurrentDirData(filteredData);
                    lastLoadedPathRef.current = path;
                    navigateTo(path);
                    return true;
                } else {
                    throw new Error(t('Failed to load SFTP directory'));
                }
            }

            // Virtual locations: Recents and colour tags (macOS Spotlight / Finder tags)
            if (path.startsWith('explr://')) {
                let json;
                if (path === 'explr://recents') {
                    json = await invoke('list_recents', { limit: 200 });
                } else if (path.startsWith('explr://tag/')) {
                    json = await invoke('files_with_tag_color', { color: Number(path.slice('explr://tag/'.length)) || 0 });
                } else {
                    throw new Error(`Unknown location: ${path}`);
                }
                setCurrentDirData(filterDirectoryData(JSON.parse(json)));
                lastLoadedPathRef.current = path;
                navigateTo(path);
                return true;
            }

            // Regular file system path
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(t('Directory loading timed out: {path}', { path }))), 10000);
            });

            const loadPromise = invoke('open_directory', { path });
            const dirContent = await Promise.race([loadPromise, timeoutPromise]);

            if (!dirContent) {
                throw new Error(`Empty response from open_directory: ${path}`);
            }

            try {
                const dirData = JSON.parse(dirContent);
                const filteredData = filterDirectoryData(dirData);
                setCurrentDirData(filteredData);
                lastLoadedPathRef.current = path;
                navigateTo(path);
                // Live refresh when the folder changes on disk
                invoke('watch_directory', { path }).catch(() => {});
                return true;
            } catch (parseError) {
                throw new Error(`Failed to parse directory data: ${parseError.message}`);
            }
        } catch (err) {
            console.error(`Failed to load directory: ${path}`, err);
            
            // Handle permission errors specifically for macOS user directories
            const errorMessage = err.message || err.toString();
            if (errorMessage.includes('permission denied') || errorMessage.includes('Permission denied')) {
                const folderName = path.split('/').pop() || path;
                const isUserDir = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music'].some(dir => 
                    path.toLowerCase().includes(dir.toLowerCase())
                );
                
                if (isUserDir) {
                    setError(t('Access denied to "{name}". This app needs permission to access your {name} folder. Please grant permission in System Preferences > Security & Privacy > Privacy > Files and Folders.', { name: folderName }));
                } else {
                    setError(t('Permission denied: Cannot access "{name}". You may need to grant additional permissions to this application.', { name: folderName }));
                }
            } else {
                setError(t('Failed to load directory: {error}', { error: errorMessage }));
            }
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [navigateTo, filterDirectoryData, isSftpPath, loadSftpDirectory]);

// Verbesserte getDefaultDirectory-Funktion
    const getDefaultDirectory = useCallback(async () => {
        // Setze isLoading auf true, um den Ladezustand anzuzeigen
        setIsLoading(true);

        try {
            // 1. Versuche zuerst, die Volumes zu laden
            console.log("Attempting to load volumes...");
            const volumesList = await loadVolumes();

            if (volumesList && volumesList.length > 0) {
                console.log(`Found volumes, using first mount point: ${volumesList[0].mount_point}`);
                return volumesList[0].mount_point;
            }

            console.warn('No volumes available, trying common paths instead');

            // 2. Liste gängiger Pfade für verschiedene Betriebssysteme
            //const commonPaths = ['/', 'C:\\', '/home', '/Users', '/tmp', '/var', '/opt'];
            const commonPaths = ['C:\\', '/Users', '/home'];

            // 3. Prüfe jeden Pfad einzeln
            for (const path of commonPaths) {
                console.log(`Checking if path is accessible: ${path}`);
                try {
                    // Verwende einen separaten try-catch für jeden Pfad
                    const result = await invoke('open_directory', { path });
                    if (result) {
                        console.log(`Successfully found accessible path: ${path}`);
                        return path;
                    }
                } catch (e) {
                    console.log(`Path ${path} not accessible`);
                    // Fehler ignorieren und mit dem nächsten Pfad fortfahren
                }
            }

            // 4. Hartcodierter Fallback als letzte Möglichkeit
            console.warn('All paths failed, using hardcoded default');
            return '/';
        } catch (error) {
            console.error('Error in getDefaultDirectory:', error);
            return '/';
        } finally {
            // Stelle sicher, dass ein Ladeindikator nicht nur wegen dieser Funktion aktiv bleibt
            // setIsLoading(false); -- Dies sollte in loadDirectory gesetzt werden, nicht hier
        }
    }, [loadVolumes]);

// Verbesserte initializeFirstDirectory-Funktion
    const initializeFirstDirectory = useCallback(async () => {
        console.log("Initializing first directory...");

        // 1. Start mit einem Timeout-Mechanismus
        let timeoutId = setTimeout(() => {
            console.error("Directory initialization timed out");
            setIsLoading(false);
            setError(t('Failed to initialize directory within the time limit'));
        }, 10000);

        try {
            // 2. Versuche ein Standardverzeichnis zu bekommen
            const defaultDir = await getDefaultDirectory();
            console.log(`Got default directory: ${defaultDir}`);

            // 3. Versuche das Verzeichnis zu laden
            const success = await loadDirectory(defaultDir);

            if (!success) {
                // 4. Wenn der erste Versuch fehlschlägt, versuche absolute Fallback-Pfade
                console.warn("First directory load failed, trying fallbacks...");
                const fallbacks = ['/', 'C:\\', '/tmp'];
                //const fallbacks = ['C:\\', '/Users', '/home'];

                for (const fallback of fallbacks) {
                    if (fallback !== defaultDir) {
                        console.log(`Trying fallback directory: ${fallback}`);
                        if (await loadDirectory(fallback)) {
                            console.log(`Successfully loaded fallback directory: ${fallback}`);
                            break;
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Failed to initialize directory:', err);
            setError(t('Failed to load any directory. Please check file system permissions.'));
        } finally {
            // Cleanup Timeout und stelle sicher, dass der Ladezustand beendet wird
            clearTimeout(timeoutId);
            setIsLoading(false);
        }
    }, [getDefaultDirectory, loadDirectory]);

// Rufe initializeFirstDirectory nur einmal beim Laden auf
    useEffect(() => {
        // Nur initialisieren, wenn noch kein Verzeichnis geladen wurde
        if (!currentDirData && !currentPath) {
            console.log("No directory data or current path, initializing first directory...");
            initializeFirstDirectory();
        } else {
            console.log("Directory already loaded or path set, skipping initialization");
        }
    }, [initializeFirstDirectory, currentDirData, currentPath]);

    // Load the folder when the path changes from outside (back/forward, tabs).
    // Skipped when loadDirectory itself just loaded this path.
    useEffect(() => {
        if (currentPath && currentPath !== lastLoadedPathRef.current) {
            loadDirectory(currentPath);
        }
    }, [currentPath, loadDirectory]);

    // Open a file - enhanced with SFTP support
    const openFile = useCallback(async (filePath) => {
        setIsLoading(true);
        setError(null);

        try {
            if (isSftpPath(filePath)) {
                // Download and open SFTP file with default application
                await downloadAndOpenSftpFile(filePath);
            } else {
                // Open local file with default application
                await invoke('open_in_default_app', { path: filePath });
            }
        } catch (err) {
            console.error(`Failed to open file: ${filePath}`, err);
            setError(t('Failed to open file: {error}', { error: err.message || err }));
        } finally {
            setIsLoading(false);
        }
    }, [isSftpPath, downloadAndOpenSftpFile]);

    // Create a new file - enhanced with SFTP support
    const createFile = useCallback(async (folderPath, fileName) => {
        setIsLoading(true);
        setError(null);

        try {
            if (isSftpPath(folderPath)) {
                const success = await createSftpFile(folderPath, fileName);
                if (success) {
                    await loadDirectory(folderPath);
                }
            } else {
                await invoke('create_file', {
                    folderPathAbs: folderPath,
                    fileName: fileName
                });
                fileOps.recordCreated(`${folderPath.replace(/\/$/, '')}/${fileName}`);
                await loadDirectory(folderPath);
            }
        } catch (err) {
            console.error(`Failed to create file: ${fileName}`, err);
            setError(t('Failed to create file: {error}', { error: err.message || err }));
        } finally {
            setIsLoading(false);
        }
    }, [loadDirectory, isSftpPath, createSftpFile]);

    // Create a new directory - enhanced with SFTP support
    const createDirectory = useCallback(async (folderPath, directoryName) => {
        setIsLoading(true);
        setError(null);

        try {
            if (isSftpPath(folderPath)) {
                const success = await createSftpDirectory(folderPath, directoryName);
                if (success) {
                    await loadDirectory(folderPath);
                }
            } else {
                await invoke('create_directory', {
                    folderPathAbs: folderPath,
                    folderName: directoryName
                });
                fileOps.recordCreated(`${folderPath.replace(/\/$/, '')}/${directoryName}`);
                await loadDirectory(folderPath);
            }
        } catch (err) {
            console.error(`Failed to create directory: ${directoryName}`, err);
            setError(t('Failed to create directory: {error}', { error: err.message || err }));
        } finally {
            setIsLoading(false);
        }
    }, [loadDirectory, isSftpPath, createSftpDirectory]);

    // Rename an item - enhanced with SFTP support
    const renameItem = useCallback(async (oldPath, newPath) => {
        setIsLoading(true);
        setError(null);

        try {
            console.log(`FileSystemProvider: Renaming "${oldPath}" -> "${newPath}"`);

            if (isSftpPath(oldPath)) {
                const pathParts = newPath.split('/');
                const newName = pathParts[pathParts.length - 1];
                const success = await renameSftpItem(oldPath, newName);
                if (success) {
                    // For SFTP paths, reload the current directory instead of trying to extract parent path
                    if (currentPath) {
                        await loadDirectory(currentPath);
                    }
                }
            } else {
                await fileOps.rename(oldPath, newPath); // undoable with Cmd+Z
                const dirPath = getDirectoryPath(oldPath);
                await loadDirectory(dirPath);
            }

            console.log('FileSystemProvider: Rename operation completed successfully');
        } catch (err) {
            console.error(`Failed to rename item: ${oldPath}`, err);
            setError(t('Failed to rename item: {error}', { error: err.message || err }));
        } finally {
            setIsLoading(false);
        }
    }, [loadDirectory, isSftpPath, renameSftpItem]);

    // Move item to trash - enhanced with SFTP support
    const moveToTrash = useCallback(async (path) => {
        setIsLoading(true);
        setError(null);

        try {
            if (isSftpPath(path)) {
                const success = await deleteSftpItem(path);
                if (success) {
                    // For SFTP paths, reload the current directory instead of trying to extract parent path
                    if (currentPath) {
                        await loadDirectory(currentPath);
                    }
                    // Clear selection if the deleted item was selected
                    setSelectedItems(prev => prev.filter(item => !item.path.startsWith(path)));
                }
            } else {
                await fileOps.trash([path]); // undoable with Cmd+Z; refresh happens via fileOps
                // Clear selection if the deleted item was selected
                setSelectedItems(prev => prev.filter(item => !item.path.startsWith(path)));
            }
        } catch (err) {
            console.error(`Failed to move item to trash: ${path}`, err);
            setError(t('Failed to move item to trash: {error}', { error: err.message || err }));
        } finally {
            setIsLoading(false);
        }
    }, [loadDirectory, isSftpPath, deleteSftpItem, currentPath]);

    // Zip selected items
    const zipItems = useCallback(async (sourcePaths, destinationPath = null) => {
        setIsLoading(true);
        setError(null);

        try {
            await invoke('zip', {
                sourcePaths,
                destinationPath
            });

            // Reload current directory to show the new zip file
            if (currentPath) {
                await loadDirectory(currentPath);
            }
        } catch (err) {
            console.error('Failed to create zip:', err);
            setError(t('Failed to create zip: {error}', { error: err.message || err }));
        } finally {
            setIsLoading(false);
        }
    }, [currentPath, loadDirectory]);

    // Unzip an item
    const unzipItem = useCallback(async (zipPath, destinationPath = null) => {
        setIsLoading(true);
        setError(null);

        try {
            await invoke('unzip', {
                zipPaths: [zipPath],
                destinationPath
            });

            // Reload current directory to show the extracted files
            if (currentPath) {
                await loadDirectory(currentPath);
            }
        } catch (err) {
            console.error(`Failed to extract zip: ${zipPath}`, err);
            setError(t('Failed to extract zip: {error}', { error: err.message || err }));
        } finally {
            setIsLoading(false);
        }
    }, [currentPath, loadDirectory]);

    // Select an item
    const selectItem = useCallback((item, isMultiSelect = false) => {
        setSelectedItems(prevSelected => {
            // Check if the item is already selected
            const isAlreadySelected = prevSelected.some(
                selected => selected.path === item.path
            );

            if (isAlreadySelected) {
                // If multi-select, toggle selection
                return isMultiSelect
                    ? prevSelected.filter(selected => selected.path !== item.path)
                    : [item]; // Otherwise, make it the only selection
            } else {
                // Add to selection for multi-select, replace for single select
                return isMultiSelect ? [...prevSelected, item] : [item];
            }
        });
    }, []);

    // Select multiple items at once
    const selectMultiple = useCallback((items) => {
        setSelectedItems(items);
    }, []);

    // Clear selection
    const clearSelection = useCallback(() => {
        setSelectedItems([]);
        setFocusedItem(null);
    }, []);

    // Set focused item (for keyboard navigation and preview)
    const setFocusedItemCallback = useCallback((item) => {
        setFocusedItem(item);
    }, []);

    // Load volumes on mount
    useEffect(() => {
        loadVolumes();
    }, [loadVolumes]);

    /**
     * Re-reads the open folder without a loading state, keeping the selection
     * (minus items that no longer exist). Used for live refresh.
     */
    const refreshDirectory = useCallback(async () => {
        const path = lastLoadedPathRef.current;
        if (!path || isSftpPath(path)) return;
        try {
            const json = await invoke('open_directory', { path });
            if (lastLoadedPathRef.current !== path) return; // navigated away meanwhile
            const data = filterDirectoryData(JSON.parse(json));
            setCurrentDirData(data);
            const existing = new Set([...(data.directories || []), ...(data.files || [])].map(i => i.path));
            setSelectedItems(prev => prev.filter(i => existing.has(i.path)));
        } catch (err) {
            console.warn('Live refresh failed:', err);
        }
    }, [filterDirectoryData, isSftpPath]);

    // Folder changed on disk -> refresh it
    useEffect(() => {
        let unlisten = null;
        let disposed = false;
        listen('directory-changed', (event) => {
            if (event.payload === lastLoadedPathRef.current) refreshDirectory();
        }).then((fn) => {
            if (disposed) fn(); else unlisten = fn;
        }).catch(() => {});
        return () => {
            disposed = true;
            if (unlisten) unlisten();
        };
    }, [refreshDirectory]);

    // Re-filter when the "show hidden files" setting changes (not on every navigation)
    const hiddenSettingRef = useRef(settings.show_hidden_files_and_folders);
    useEffect(() => {
        if (hiddenSettingRef.current === settings.show_hidden_files_and_folders) return;
        hiddenSettingRef.current = settings.show_hidden_files_and_folders;
        refreshDirectory();
    }, [settings.show_hidden_files_and_folders, refreshDirectory]);

    const contextValue = {
        refreshDirectory,
        currentDirData,
        isLoading,
        selectedItems,
        focusedItem,
        volumes,
        error,
        loadDirectory,
        openFile,
        createFile,
        createDirectory,
        renameItem,
        moveToTrash,
        selectItem,
        selectMultiple,
        clearSelection,
        setFocusedItem: setFocusedItemCallback,
        zipItems,
        unzipItem,
        loadVolumes,
    };

    return (
        <FileSystemContext.Provider value={contextValue}>
            {children}
        </FileSystemContext.Provider>
    );
}

// Custom hook for using the file system context
export const useFileSystem = () => useContext(FileSystemContext);