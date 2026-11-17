import { useSyncExternalStore } from 'react';
import ru from './ru';

/**
 * Tiny i18n layer.
 * Keys are the original English strings, so anything missing from a
 * dictionary falls back to English automatically.
 */

const STORAGE_KEY = 'explr.language';
const SUPPORTED = ['ru', 'en'];
const DICTIONARIES = { ru };

const detectLanguage = () => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (SUPPORTED.includes(stored)) return stored;
    } catch {
        // storage unavailable
    }
    const nav = (typeof navigator !== 'undefined' && navigator.language) || '';
    return nav.toLowerCase().startsWith('ru') ? 'ru' : 'en';
};

let currentLanguage = detectLanguage();
const listeners = new Set();

const applyDocumentLanguage = () => {
    try {
        document.documentElement.lang = currentLanguage;
    } catch {
        // no DOM
    }
};
applyDocumentLanguage();

export const getLanguage = () => currentLanguage;

/** BCP 47 locale for Intl APIs. */
export const getLocale = () => (currentLanguage === 'ru' ? 'ru-RU' : 'en-US');

export const setLanguage = (language) => {
    if (!SUPPORTED.includes(language) || language === currentLanguage) return;
    currentLanguage = language;
    try {
        localStorage.setItem(STORAGE_KEY, language);
    } catch {
        // storage unavailable
    }
    applyDocumentLanguage();
    listeners.forEach((listener) => listener());
};

const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

const interpolate = (text, vars) => {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
            ? String(vars[name])
            : match
    );
};

/**
 * Translate an English UI string into the active language.
 * @param {string} text - The English source string (also the dictionary key).
 * @param {Object} [vars] - Values for `{name}` placeholders.
 */
export const t = (text, vars) => {
    if (typeof text !== 'string') return text;
    const dict = DICTIONARIES[currentLanguage];
    const translated = (dict && dict[text]) || text;
    return interpolate(translated, vars);
};

/**
 * Pick the plural form for a count.
 * forms: { one, few, many } for Russian, { one, other } for English.
 * Each form may contain `{count}`. Forms are English keys run through `t`
 * unless `forms.ru` / `forms.en` are given explicitly.
 *
 * Usage: plural(n, { en: ['{count} item', '{count} items'], ru: ['{count} объект', '{count} объекта', '{count} объектов'] })
 */
export const plural = (n, forms, vars) => {
    const count = Number(n) || 0;
    const allVars = { count, ...vars };
    if (currentLanguage === 'ru') {
        const [one, few, many] = forms.ru;
        const abs = Math.abs(count);
        const mod10 = abs % 10;
        const mod100 = abs % 100;
        let form = many;
        if (mod10 === 1 && mod100 !== 11) form = one;
        else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) form = few;
        return interpolate(form, allVars);
    }
    const [one, other] = forms.en;
    return interpolate(count === 1 ? one : other, allVars);
};

/** Common count phrases shared across the UI. */
export const PLURALS = {
    items: { en: ['{count} item', '{count} items'], ru: ['{count} объект', '{count} объекта', '{count} объектов'] },
    files: { en: ['{count} file', '{count} files'], ru: ['{count} файл', '{count} файла', '{count} файлов'] },
    folders: { en: ['{count} folder', '{count} folders'], ru: ['{count} папка', '{count} папки', '{count} папок'] },
    selected: { en: ['{count} selected', '{count} selected'], ru: ['выбран {count}', 'выбрано {count}', 'выбрано {count}'] },
    results: { en: ['{count} result', '{count} results'], ru: ['{count} результат', '{count} результата', '{count} результатов'] },
};

/**
 * React hook: subscribes the component to language changes.
 * Returns { t, plural, language, locale, setLanguage }.
 */
export const useI18n = () => {
    const language = useSyncExternalStore(subscribe, getLanguage, getLanguage);
    return { t, plural, PLURALS, language, locale: getLocale(), setLanguage };
};

export default t;
