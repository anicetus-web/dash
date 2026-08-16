// Конфигурация pm2 — АЛЬТЕРНАТИВА systemd (deploy/dash.service), не обе сразу.
// Выбирай, если pm2 уже стоит на сервере или предпочитаешь его интерфейс
// (pm2 monit, pm2 logs, автоматическую ротацию логов через pm2-logrotate).
// В духе проекта основной путь — systemd (deploy/dash.service): без лишней
// npm-зависимости на сервере. Подробности — DEPLOY.md.
//
// Расширение ИМЕННО .cjs, не .js: у проекта "type": "module" в package.json,
// и обычный ecosystem.config.js под require() (так его грузит pm2) молча
// вернул бы пустой объект вместо конфигурации — .cjs форсирует CommonJS
// независимо от package.json.
//
// Запуск:
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save
//   pm2 startup   # даёт команду для автозапуска pm2 при перезагрузке сервера — выполнить её отдельно

module.exports = {
  apps: [
    {
      name: 'dash',
      script: 'src/server.js',
      cwd: '/opt/dash',
      // .env читается самим приложением через process.env — pm2 подставляет
      // переменные окружения, только если задать их здесь явно (env_file
      // штатно не читает .env-файл, в отличие от systemd EnvironmentFile).
      // Проще всего: dotenv-подобный файл не нужен — .env лежит рядом,
      // и его достаточно экспортировать перед запуском pm2 (см. DEPLOY.md),
      // либо перечислить нужные переменные ниже вручную.
      env: {
        NODE_ENV: 'production'
      },
      instances: 1, // ВАЖНО: ровно один инстанс — приложение держит состояние
      // синхронизации в памяти процесса (единственность синхронизации,
      // таймер автообновления). cluster-режим pm2 (несколько инстансов
      // одного порта) для этого приложения не подходит.
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: '/opt/dash/logs/out.log',
      error_file: '/opt/dash/logs/error.log',
      time: true
    }
  ]
};
