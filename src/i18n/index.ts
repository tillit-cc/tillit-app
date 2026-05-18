import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';
import it from './it';
import en from './en';

const deviceLang = Localization.getLocales()[0]?.languageCode ?? 'it';

i18next.use(initReactI18next).init({
  resources: { it: { translation: it }, en: { translation: en } },
  lng: deviceLang === 'en' ? 'en' : 'it',
  fallbackLng: 'it',
  interpolation: { escapeValue: false },
});

export default i18next;
