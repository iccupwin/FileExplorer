/**
 * Russian dictionary. Keys are the English UI strings.
 * Split by area to keep files manageable; later entries win on duplicates.
 */
import common from './ru/common';
import explorer from './ru/explorer';
import search from './ru/search';
import menus from './ru/menus';
import places from './ru/places';
import settings from './ru/settings';
import fileTypes from './ru/fileTypes';
import features from './ru/features';

export default {
    ...explorer,
    ...search,
    ...menus,
    ...places,
    ...settings,
    ...fileTypes,
    ...features,
    ...common,
};
