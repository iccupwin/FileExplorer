import { describe, it, expect, beforeEach } from 'vitest';
import { t, plural, PLURALS, setLanguage } from '../i18n';

describe('i18n', () => {
    beforeEach(() => setLanguage('ru'));

    it('translates known strings and falls back to English', () => {
        setLanguage('en');
        expect(t('Name')).toBe('Name');
        setLanguage('ru');
        expect(t('Name')).not.toBe('Name');
        expect(t('Some string that has no translation')).toBe('Some string that has no translation');
    });

    it('uses Russian plural forms', () => {
        expect(plural(1, PLURALS.items)).toBe('1 объект');
        expect(plural(3, PLURALS.items)).toBe('3 объекта');
        expect(plural(5, PLURALS.items)).toBe('5 объектов');
        expect(plural(11, PLURALS.items)).toBe('11 объектов');
        expect(plural(21, PLURALS.items)).toBe('21 объект');
        expect(plural(112, PLURALS.items)).toBe('112 объектов');
    });

    it('uses English plurals', () => {
        setLanguage('en');
        expect(plural(1, PLURALS.files)).toBe('1 file');
        expect(plural(2, PLURALS.files)).toBe('2 files');
    });
});
