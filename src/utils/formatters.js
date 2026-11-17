import { t, plural, getLanguage, getLocale } from '../i18n';

/**
 * Format a file size in bytes to a human-readable string.
 * @param {number} bytes - The file size in bytes.
 * @param {number} decimals - The number of decimal places to show.
 * @returns {string} The formatted file size.
 */
export const formatFileSize = (bytes, decimals = 1) => {
    const ru = getLanguage() === 'ru';
    const sizes = ru
        ? ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ', 'ЭБ', 'ЗБ', 'ЙБ']
        : ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    if (bytes === 0) return '0 ' + sizes[0];

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    const value = parseFloat((bytes / Math.pow(k, i)).toFixed(dm));
    // Russian uses a decimal comma
    return (ru ? String(value).replace('.', ',') : value) + ' ' + sizes[i];
};

/**
 * Format a date string to a human-readable format.
 * @param {string} dateString - The date string to format.
 * @param {boolean} includeTime - Whether to include the time.
 * @returns {string} The formatted date.
 */
export const formatDate = (dateString, includeTime = false) => {
    if (!dateString) return t('Unknown');

    try {
        const date = new Date(dateString);

        // Check if the date is valid
        if (isNaN(date.getTime())) {
            return t('Invalid date');
        }

        const options = {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        };

        if (includeTime) {
            options.hour = '2-digit';
            options.minute = '2-digit';
            options.hour12 = getLanguage() !== 'ru';
        }

        return new Intl.DateTimeFormat(getLocale(), options).format(date);
    } catch (error) {
        console.error('Error formatting date:', error);
        return t('Invalid date');
    }
};

/**
 * Get a human-readable file type based on the file extension.
 * @param {string} filename - The filename to extract the extension from.
 * @returns {string} The human-readable file type.
 */
export const getFileType = (filename) => {
    if (!filename || !filename.includes('.')) {
        return t('File');
    }

    const extension = filename.split('.').pop().toLowerCase();

    const fileTypes = {
        // Documents
        'pdf': 'PDF Document',
        'doc': 'Word Document',
        'docx': 'Word Document',
        'xls': 'Excel Spreadsheet',
        'xlsx': 'Excel Spreadsheet',
        'ppt': 'PowerPoint Presentation',
        'pptx': 'PowerPoint Presentation',
        'txt': 'Text Document',
        'rtf': 'Rich Text Document',
        'odt': 'OpenDocument Text',
        'ods': 'OpenDocument Spreadsheet',
        'odp': 'OpenDocument Presentation',
        'csv': 'CSV File',
        'md': 'Markdown Document',

        // Images
        'jpg': 'JPEG Image',
        'jpeg': 'JPEG Image',
        'png': 'PNG Image',
        'gif': 'GIF Image',
        'bmp': 'Bitmap Image',
        'svg': 'SVG Image',
        'webp': 'WebP Image',
        'tiff': 'TIFF Image',
        'ico': 'Icon File',

        // Audio
        'mp3': 'MP3 Audio',
        'wav': 'WAV Audio',
        'ogg': 'OGG Audio',
        'flac': 'FLAC Audio',
        'm4a': 'M4A Audio',
        'aac': 'AAC Audio',

        // Video
        'mp4': 'MP4 Video',
        'avi': 'AVI Video',
        'mov': 'QuickTime Video',
        'wmv': 'Windows Media Video',
        'mkv': 'Matroska Video',
        'webm': 'WebM Video',

        // Archives
        'zip': 'ZIP Archive',
        'rar': 'RAR Archive',
        '7z': '7-Zip Archive',
        'tar': 'TAR Archive',
        'gz': 'GZip Archive',
        'bz2': 'BZip2 Archive',

        // Programming
        'html': 'HTML File',
        'css': 'CSS File',
        'js': 'JavaScript File',
        'jsx': 'React JSX File',
        'ts': 'TypeScript File',
        'tsx': 'React TSX File',
        'json': 'JSON File',
        'xml': 'XML File',
        'yaml': 'YAML File',
        'toml': 'TOML File',
        'py': 'Python File',
        'java': 'Java File',
        'c': 'C File',
        'cpp': 'C++ File',
        'h': 'C Header File',
        'cs': 'C# File',
        'php': 'PHP File',
        'rb': 'Ruby File',
        'go': 'Go File',
        'rs': 'Rust File',
        'swift': 'Swift File',
        'kt': 'Kotlin File',
        'sql': 'SQL File',

        // Executables
        'exe': 'Windows Executable',
        'msi': 'Windows Installer',
        'app': 'macOS Application',
        'dmg': 'macOS Disk Image',
        'deb': 'Debian Package',
        'rpm': 'Red Hat Package',
        'apk': 'Android Package',

        // Other
        'iso': 'Disk Image',
        'torrent': 'Torrent File',
    };

    if (fileTypes[extension]) return t(fileTypes[extension]);
    return t('{ext} File', { ext: extension.toUpperCase() });
};

/**
 * Calculate the time elapsed since a specific date.
 * @param {string} dateString - The date string to calculate from.
 * @returns {string} The elapsed time as a human-readable string.
 */
export const calculateTimeElapsed = (dateString) => {
    if (!dateString) return t('Unknown');

    try {
        const date = new Date(dateString);
        const now = new Date();

        // Check if the date is valid
        if (isNaN(date.getTime())) {
            return t('Invalid date');
        }

        const seconds = Math.floor((now - date) / 1000);

        if (seconds < 60) {
            return t('Just now');
        }

        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) {
            return plural(minutes, { en: ['{count} minute ago', '{count} minutes ago'], ru: ['{count} минуту назад', '{count} минуты назад', '{count} минут назад'] });
        }

        const hours = Math.floor(minutes / 60);
        if (hours < 24) {
            return plural(hours, { en: ['{count} hour ago', '{count} hours ago'], ru: ['{count} час назад', '{count} часа назад', '{count} часов назад'] });
        }

        const days = Math.floor(hours / 24);
        if (days < 30) {
            return plural(days, { en: ['{count} day ago', '{count} days ago'], ru: ['{count} день назад', '{count} дня назад', '{count} дней назад'] });
        }

        const months = Math.floor(days / 30);
        if (months < 12) {
            return plural(months, { en: ['{count} month ago', '{count} months ago'], ru: ['{count} месяц назад', '{count} месяца назад', '{count} месяцев назад'] });
        }

        const years = Math.floor(months / 12);
        return plural(years, { en: ['{count} year ago', '{count} years ago'], ru: ['{count} год назад', '{count} года назад', '{count} лет назад'] });
    } catch (error) {
        console.error('Error calculating time elapsed:', error);
        return t('Unknown');
    }
};