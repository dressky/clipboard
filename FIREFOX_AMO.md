# Firefox Add-ons (AMO): Заявка и материалы для публикации

## Пакет для загрузки

- **Файл пакета**: `dist/clipboard-firefox-v1.2.0.zip`
- **Команда сборки**: `npm run package` (`node tools/package-stores.js`)
- **Идентификатор дополнения (`gecko.id`)**: `clipboard-local-private@dressky.github.io`
- **Минимальная версия Firefox**: `140.0` (desktop), `142.0` (`gecko_android`, требуется для `data_collection_permissions`)
- **Проверка `addons-linter`**: `0 errors`, `0 notices` (7 предупреждений `UNSUPPORTED_API` относятся к `chrome.sidePanel.open`, который вызывается только после проверки `chrome.sidePanel?.open` и отключён в интерфейсе Firefox).

---

## Поля формы на addons.mozilla.org

- **Name**: `Clipboard - Local & Private`
- **Add-on URL**: `clipboard-local-private`
- **Summary (<= 250 chars)**:
  `Локальный менеджер буфера обмена: текст, ссылки, фото и видео с быстрым доступом по Alt+V. Хранение только на устройстве без серверов и аналитики.` *(146 символов)*
- **Categories** (до 2): `Other` (или `Productivity`), `Privacy & Security`
- **License**: `MIT License`
- **Homepage**: `https://github.com/dressky/clipboard`
- **Support URL**: `https://github.com/dressky/clipboard/issues`
- **Privacy Policy URL**: `https://github.com/dressky/clipboard/blob/main/PRIVACY.md`
- **Requires payment / account**: `No`
- **Data Collection Permissions**: `required: ["none"]` (в манифесте Firefox-сборки уже указано; в анкете AMO выбрать вариант без сбора данных)
- **Source Code Upload**: `No` — код не минифицирован и не обфусцирован (`background/`, `content/`, `lib/`, `ui/` упакованы в исходном виде). При необходимости воспроизводимой сборки прикрепить архив репозитория с командой `node tools/package-stores.js`.

### Description (для страницы в Firefox Add-ons)

```text
Clipboard — локальный менеджер буфера обмена в браузере. Сохраняет скопированный текст, ссылки, изображения и видео на вашем устройстве и помогает быстро вставить нужный элемент.

Основные возможности:
• Плавающая панель поверх любой страницы по Alt+V (работает в английской и русской раскладках).
• Автозахват скопированного текста и сохранение текста, ссылок, картинок и видео через контекстное меню.
• Перетаскивание (drag-and-drop) сохранённых картинок и видео на сайты и быстрая вставка текста в активное поле.
• Закрепление важных записей — они не переносятся в архив и не удаляются при очистке по сроку хранения.
• Поиск по истории и фильтры: Текст, Ссылки, Фото, Видео, Закрепленные и Архив.
• Ограничение длины активной ленты с переносом в архив и необязательное сжатие старых незакреплённых фото.
• Список исключённых сайтов и запрет захвата полей ввода пароля.
• Экспорт и импорт резервной копии в локальный JSON-файл.

Приватность:
Вся история и настройки хранятся только локально в вашем браузере. В расширении нет аккаунтов, рекламы, аналитики и фоновой передачи данных.
```

---

## Notes to Reviewers (для ревьюеров Mozilla AMO)

Скопируйте этот текст в поле **Notes to Reviewers** при подаче заявки:

```text
This add-on is a 100% local clipboard manager with no backend servers, analytics, telemetry, or remote scripts. Source files in the XPI are unminified and match https://github.com/dressky/clipboard.

To reproduce the exact Firefox XPI/ZIP build from source:
  node tools/package-stores.js
Output: dist/clipboard-firefox-v1.2.0.zip

Permissions and API usage:
1. <all_urls>, activeTab, tabs, scripting:
   Needed so the Alt+V in-page palette and copy auto-capture work on any user-visited web page (excluding restricted browser URLs and user-configured excluded domains), and to grab image data when the user clicks "Save image to Clipboard" from the context menu.
2. clipboardRead / clipboardWrite:
   Used only on explicit user action (opening the panel or clicking a card / Paste / Copy) to read copied content or write the selected entry back to the system clipboard.
3. unlimitedStorage / storage:
   Used to persist user settings and local clipboard media blobs without hitting the small default quota.
4. Network requests:
   The add-on makes no background network calls. Network fetch occurs only when the user explicitly selects "Save image to Clipboard" or "Save video to Clipboard" in the context menu (image fetch uses credentials: 'omit').
5. Chrome-only sidePanel guard:
   background/service-worker.js, ui/panel.js, and content/content-script.js share codebase with Chromium and guard every chrome.sidePanel call with feature detection (`chrome.sidePanel?.open`). When unsupported in Firefox, the UI automatically hides the side panel option and falls back to opening ui/panel.html in a standalone popup window.
6. Background Event Page:
   The Firefox package uses `background.scripts: ["lib/db.js", "background/service-worker.js"]`, and `importScripts` inside service-worker.js is guarded by `typeof importScripts === 'function'`.
```

---

## Скриншоты и чеклист перед отправкой

- **Скриншоты (`1280x800` PNG)**:
  - `screenshots/store-overlay-1280x800.png`
  - `screenshots/store-popup-1280x800.png`
- **Чеклист перед загрузкой на `addons.mozilla.org`**:
  1. Выполнить `npm run package && npm test` — убедиться, что все тесты прошли.
  2. Проверить пакет линтером Mozilla: `addons-linter dist/clipboard-firefox-v1.2.0.zip` — `0 errors`, `0 notices`.
  3. Проверить установку в Firefox (`about:debugging#/runtime/this-firefox` -> **Загрузить временное дополнение** -> `dist/clipboard-firefox-v1.2.0.zip`): убедиться, что popup, `Alt+V`, сохранение текста/фото и окно настроек работают без упоминания Chrome Side Panel.
  4. Загрузить `dist/clipboard-firefox-v1.2.0.zip` в AMO Developer Hub и заполнить поля по шаблону выше.
