/**
 * Адаптер источника данных.
 *
 * Расчётный модуль и интерфейс не знают, откуда взялся снимок. Между ними и
 * Битриксом стоит один интерфейс с двумя реализациями: детерминированный
 * генератор для разработки и демонстрации, и реальный портал.
 *
 * Подстановка боевых доступов — смена переменной окружения, а не правка логики.
 */

import { config } from '../config.js';

/**
 * @typedef {object} DataSource
 * @property {string}   name        'demo' | 'bitrix'
 * @property {boolean}  ready       готов ли источник отдавать данные
 * @property {string?}  blockedBy   человеческая причина неготовности
 * @property {Function} fetchSnapshot  (options) => Promise<snapshot>
 */

/** Демонстрационный источник: снимок собирается генератором по фиксированному зерну. */
function createDemoSource() {
  return {
    name: 'demo',
    ready: true,
    blockedBy: null,
    async fetchSnapshot(options = {}) {
      // Импорт отложен: демо-генератор не нужен в боевом режиме и не должен
      // попадать в память процесса, работающего с реальным порталом.
      const { generateDemoSnapshot } = await import('../demo/generator.js');
      return generateDemoSnapshot({
        seed: options.seed ?? config.demoSeed,
        now: options.now ?? new Date(),
        timeZone: options.timeZone ?? config.portalTimezone
      });
    }
  };
}

/** Боевой источник: реальный портал Битрикс24 через VibeCode API. */
function createBitrixSource() {
  const ready = Boolean(config.bitrixApiKey);
  return {
    name: 'bitrix',
    ready,
    blockedBy: ready
      ? null
      : 'Не задан ключ доступа к Битрикс24 (переменная BITRIX_API_KEY). Данные с портала не получить.',
    async fetchSnapshot(options = {}) {
      if (!ready) {
        const error = new Error('Ключ доступа к Битрикс24 не задан');
        error.code = 'NO_API_KEY';
        throw error;
      }
      const { fetchBitrixSnapshot } = await import('../bitrix/fullSync.js');
      return fetchBitrixSnapshot(options);
    }
  };
}

/** Источник по имени. Неизвестное имя — демо: приложение обязано подняться. */
export function createSource(name = config.dataSource) {
  return name === 'bitrix' ? createBitrixSource() : createDemoSource();
}
