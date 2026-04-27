(function () {
    'use strict';

    // ===================== Константы =====================

    /** Ширина панели закладок (в пикселях) */
    const BOOKMARK_WIDTH = 20;

    /** Высота одной кнопки-закладки (в пикселях) */
    const BOOKMARK_HEIGHT = 95;

    /** Шаг между закладками по вертикали (определяет, сколько закладок будет на странице) */
    const BOOKMARK_STEP = 100;

    /** Задержка перед показом кнопки «Установить закладку» при наведении (в миллисекундах) */
    const HOVER_DELAY = 1000;

    /** Имя базы данных IndexedDB */
    const DB_NAME = 'BookmarkDB';

    /** Версия базы данных (увеличивать при изменении структуры) */
    const DB_VERSION = 1;

    /** Название объектного хранилища в IndexedDB */
    const STORE_NAME = 'bookmarks';

    /** Префикс для хэша в URL (пример: #bookmark5) */
    const HASH_PREFIX = 'bookmark';

    // ===================== Глобальные переменные =====================

    /** Ссылка на открытую базу IndexedDB */
    let db = null;

    /** Индекс текущей активной закладки (0-based) */
    let activeIndex = 0;

    /** Массив всех созданных кнопок-закладок */
    let bookmarkButtons = [];

    /** Контейнер всей панели закладок (фиксирован справа) */
    let container = null;

    /** Внутренний контейнер, который сдвигается при скролле страницы */
    let inner = null;

    /** Кнопка «Установить закладку», появляющаяся при долгом наведении */
    let setButton = null;

    /** Таймер для задержки показа кнопки «Установить закладку» */
    let hoverTimeout = null;

    /** Индекс закладки, над которой сейчас находится курсор (для обработки hover) */
    let currentHoveredIndex = null;

    /** Флаг: находится ли курсор над кнопкой «Установить закладку» */
    let isMouseOverSetButton = false;

    /** Флаг для предотвращения рекурсивного срабатывания события hashchange при программном изменении хэша */
    let suppressHashChange = false;

    /** Уникальный ключ записи в IndexedDB для текущей страницы (зависит от URL) */
    let RECORD_KEY = '';

    // ===================== Ключ на основе имени файла =====================

    /**
     * Создаёт уникальный ключ для хранения закладки в IndexedDB на основе текущего пути страницы.
     * Это позволяет сохранять закладки отдельно для каждой страницы сайта.
     * @returns {string} Ключ вида 'bm_/path/to/page.html'
     */
    function buildRecordKey() {
        const path = window.location.pathname || '';
        const segments = path.split('/');
        let filename = segments[segments.length - 1] || '';
        if (!filename) {
            filename = path || 'default';
        }

        return 'bm_' + path;
    }

    // ===================== IndexedDB =====================

    /**
     * Открывает (или создаёт) базу данных IndexedDB.
     * При необходимости выполняет обновление структуры (onupgradeneeded).
     * @returns {Promise<IDBDatabase>} Промис с объектом базы данных
     */
    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const database = e.target.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME);
                }
            };
            request.onsuccess = (e) => {
                db = e.target.result;
                resolve(db);
            };
            request.onerror = (e) => {
                reject(e.target.error);
            };
        });
    }

    /**
     * Сохраняет индекс активной закладки в IndexedDB.
     * @param {number} index - Индекс закладки для сохранения
     * @returns {Promise<void>}
     */
    function saveActiveIndex(index) {
        return new Promise((resolve, reject) => {
            if (!db) { reject('DB not open'); return; }
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put(index, RECORD_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Загружает ранее сохранённый индекс активной закладки из IndexedDB.
     * Если запись отсутствует — возвращает 0 (первая закладка).
     * @returns {Promise<number>} Индекс активной закладки
     */
    function loadActiveIndex() {
        return new Promise((resolve, reject) => {
            if (!db) { reject('DB not open'); return; }
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(RECORD_KEY);
            request.onsuccess = () => {
                resolve(request.result !== undefined ? request.result : 0);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // ===================== Hash =====================

    /**
     * Извлекает индекс закладки из URL-хэша (например, из #bookmark5).
     * @returns {number|null} Индекс закладки или null, если хэш некорректный
     */
    function parseHashIndex() {
        const hash = window.location.hash;
        if (!hash) return null;
        const match = hash.match(new RegExp('^#' + HASH_PREFIX + '(\\d+)$'));
        if (match) {
            return parseInt(match[1], 10);
        }
        return null;
    }

    /**
     * Устанавливает хэш в URL без вызова события hashchange.
     * Используется suppressHashChange для предотвращения зацикливания.
     * @param {number} index - Индекс закладки
     */
    function setHash(index) {
        suppressHashChange = true;
        window.location.hash = HASH_PREFIX + index;
        setTimeout(() => { suppressHashChange = false; }, 50);
    }

    /**
     * Обработчик изменения хэша в адресной строке.
     * Если хэш корректный — активирует соответствующую закладку и прокручивает страницу.
     */
    function onHashChange() {
        if (suppressHashChange) return;
        const idx = parseHashIndex();
        if (idx !== null && idx >= 0 && idx < bookmarkButtons.length) {
            activeIndex = idx;
            highlightActive();
            saveActiveIndex(activeIndex);
            scrollToBookmarkPosition(activeIndex);
        }
    }

    // ===================== Установка активной закладки =====================

    /**
     * Делает закладку с указанным индексом активной:
     * подсвечивает её, сохраняет в БД и обновляет хэш.
     * @param {number} index - Индекс закладки
     */
    function setActiveBookmark(index) {
        activeIndex = index;
        highlightActive();
        saveActiveIndex(activeIndex);
        setHash(activeIndex);
    }

    // ===================== UI =====================

    /**
     * Вычисляет количество закладок на основе текущей высоты страницы.
     * @returns {number} Количество закладок (минимум 1)
     */
    function getBookmarkCount() {
        const docHeight = Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight
        );
        return Math.max(1, Math.floor(docHeight / BOOKMARK_STEP));
    }

    /**
     * Создаёт и добавляет CSS-стили для панели закладок и кнопки установки.
     * Использует CSS-переменную --progress для отображения градиента прогресса.
     */
    function createStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #bookmark-container {
                position: fixed;
                top: 0;
                right: 0;
                width: ${BOOKMARK_WIDTH}px;
                height: 100vh;
                overflow: hidden;
                z-index: 100;
                pointer-events: none;
            }

            #bookmark-inner {
                position: absolute;
                top: 0;
                left: 0;
                width: ${BOOKMARK_WIDTH}px;
            }

            .bm-btn {
                position: absolute;
                width: ${BOOKMARK_WIDTH}px;
                height: ${BOOKMARK_HEIGHT}px;
                box-sizing: border-box;
                border: 1px solid #888;
                background: linear-gradient(to top, #b0bec5 var(--progress), #ddd var(--progress));
                cursor: pointer;
                pointer-events: auto;
                font-size: 10px;
                color: #333;
                text-align: center;
                line-height: ${BOOKMARK_HEIGHT}px;
                user-select: none;
                transition: border-color 0.2s;
                padding: 0;
                margin: 0;
                right: 0;
            }
            .bm-btn:hover {
                border-color: #333;
                background: linear-gradient(to top, #90a4ae var(--progress), #ccc var(--progress));
            }
            .bm-btn.active {
                background: linear-gradient(to top, #4caf50 var(--progress), #c8e6c9 var(--progress));
                color: #000;
                font-weight: bold;
                border-color: #2e7d32;
            }

            #bm-set-btn {
                position: fixed;
                white-space: nowrap;
                padding: 6px 10px;
                background: #2196f3;
                color: #fff;
                border: none;
                cursor: pointer;
                font-size: 12px;
                z-index: 2147483647;
                border-radius: 3px;
                display: none;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            }
            #bm-set-btn:hover {
                background: #1769aa;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Создаёт основной контейнер панели закладок и все кнопки-закладки.
     * Для каждой кнопки рассчитывается процент прогресса и устанавливается CSS-переменная --progress.
     */
    function createContainer() {
        container = document.createElement('div');
        container.id = 'bookmark-container';

        const count = getBookmarkCount();

        inner = document.createElement('div');
        inner.id = 'bookmark-inner';
        inner.style.height = ((count - 1) * BOOKMARK_STEP + BOOKMARK_HEIGHT) + 'px';
        container.appendChild(inner);

        for (let i = 0; i < count; i++) {
            const btn = document.createElement('button');
            btn.className = 'bm-btn';
            btn.dataset.index = i;
            btn.textContent = i + 1;
            btn.style.top = (i * BOOKMARK_STEP) + 'px';

            // Процент заполнения кнопки (от 0% до 100%)
            const percentage = ((i + 1) / count) * 100;
            btn.style.setProperty('--progress', percentage + '%');

            inner.appendChild(btn);
            bookmarkButtons.push(btn);

            btn.addEventListener('click', onBookmarkClick);
            btn.addEventListener('mouseenter', onBookmarkMouseEnter);
            btn.addEventListener('mouseleave', onBookmarkMouseLeave);
        }

        document.body.appendChild(container);
    }

    /**
     * Создаёт плавающую кнопку «Установить закладку».
     */
    function createSetButton() {
        setButton = document.createElement('button');
        setButton.id = 'bm-set-btn';
        setButton.textContent = 'Установить закладку';
        setButton.addEventListener('click', onSetBookmarkClick);
        setButton.addEventListener('mouseenter', () => { isMouseOverSetButton = true; });
        setButton.addEventListener('mouseleave', onSetButtonMouseLeave);
        document.body.appendChild(setButton);
    }

    /**
     * Подсвечивает активную закладку (добавляет класс .active).
     */
    function highlightActive() {
        bookmarkButtons.forEach((btn, i) => {
            btn.classList.toggle('active', i === activeIndex);
        });
    }

    // ===================== Синхронизация позиции inner =====================

    /**
     * Синхронизирует положение панели закладок при скролле страницы.
     * Панель «плывёт» так, чтобы визуально соответствовать текущему прогрессу прокрутки.
     */
    function syncPosition() {
        const docHeight = Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight
        );
        const viewportHeight = window.innerHeight;
        const maxPageScroll = docHeight - viewportHeight;

        if (maxPageScroll <= 0) {
            inner.style.transform = 'translateY(0px)';
            return;
        }

        const innerHeight = inner.offsetHeight;
        const maxInnerOffset = innerHeight - viewportHeight;

        if (maxInnerOffset <= 0) {
            inner.style.transform = 'translateY(0px)';
            return;
        }

        const ratio = window.scrollY / maxPageScroll;
        const offset = -(ratio * maxInnerOffset);
        inner.style.transform = 'translateY(' + offset + 'px)';
    }

    // ===================== Обработчики =====================

    /**
     * Обработчик клика по кнопке-закладке.
     * Прокручивает страницу к позиции текущей активной закладки.
     * @param {MouseEvent} e
     */
    function onBookmarkClick(e) {
        e.stopPropagation();
        scrollToBookmarkPosition(activeIndex);
    }

    /**
     * Обработчик наведения курсора на закладку.
     * Запускает таймер для показа кнопки «Установить закладку».
     * @param {MouseEvent} e
     */
    function onBookmarkMouseEnter(e) {
        const idx = parseInt(e.target.dataset.index, 10);
        currentHoveredIndex = idx;
        clearTimeout(hoverTimeout);
        hoverTimeout = setTimeout(() => {
            if (currentHoveredIndex === idx) {
                showSetButton(idx);
            }
        }, HOVER_DELAY);
    }

    /**
     * Обработчик ухода курсора с закладки.
     * Сбрасывает таймер и через небольшую задержку скрывает кнопку установки.
     * @param {MouseEvent} e
     */
    function onBookmarkMouseLeave(e) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
        currentHoveredIndex = null;

        setTimeout(() => {
            if (!isMouseOverSetButton && currentHoveredIndex === null) {
                hideSetButton();
            }
        }, 300);
    }

    /**
     * Обработчик ухода курсора с кнопки «Установить закладку».
     * @param {MouseEvent} e
     */
    function onSetButtonMouseLeave(e) {
        isMouseOverSetButton = false;
        setTimeout(() => {
            if (currentHoveredIndex === null && !isMouseOverSetButton) {
                hideSetButton();
            }
        }, 300);
    }

    /**
     * Показывает кнопку «Установить закладку» рядом с выбранной закладкой.
     * @param {number} index - Индекс закладки
     */
    function showSetButton(index) {
        const btn = bookmarkButtons[index];
        if (!btn) return;

        const rect = btn.getBoundingClientRect();

        setButton.style.display = 'block';

        const setRect = setButton.getBoundingClientRect();
        const topPos = rect.top + (rect.height / 2) - (setRect.height / 2);
        const leftPos = rect.left - setRect.width - 4;

        setButton.style.top = topPos + 'px';
        setButton.style.left = leftPos + 'px';
        setButton.dataset.targetIndex = index;

        isMouseOverSetButton = false;
    }

    /**
     * Скрывает кнопку «Установить закладку».
     */
    function hideSetButton() {
        setButton.style.display = 'none';
    }

    /**
     * Обработчик клика по кнопке «Установить закладку».
     * Делает текущую закладку активной и скрывает кнопку.
     * @param {MouseEvent} e
     */
    function onSetBookmarkClick(e) {
        e.stopPropagation();
        const idx = parseInt(setButton.dataset.targetIndex, 10);
        if (isNaN(idx)) return;
        setActiveBookmark(idx);
        hideSetButton();
    }

    /**
     * Плавно прокручивает страницу к позиции указанной закладки.
     * @param {number} index - Индекс закладки
     */
    function scrollToBookmarkPosition(index) {
        const docHeight = Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight
        );
        const count = getBookmarkCount();
        if (count <= 1) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        const targetY = (index / (count - 1)) * (docHeight - window.innerHeight);
        window.scrollTo({ top: targetY, behavior: 'smooth' });
    }

    // ===================== Инициализация =====================

    /**
     * Основная функция инициализации скрипта.
     * Открывает БД, создаёт UI, восстанавливает сохранённую закладку,
     * настраивает обработчики событий.
     */
    async function init() {
        RECORD_KEY = buildRecordKey();

        let savedIndex = 0;
        try {
            await openDB();
            savedIndex = await loadActiveIndex();
        } catch (e) {
            console.warn('IndexedDB error, defaulting to 0:', e);
        }

        createStyles();
        createContainer();
        createSetButton();

        const hashIndex = parseHashIndex();
        if (hashIndex !== null && hashIndex >= 0 && hashIndex < bookmarkButtons.length) {
            activeIndex = hashIndex;
        } else if (savedIndex >= 0 && savedIndex < bookmarkButtons.length) {
            activeIndex = savedIndex;
        } else {
            activeIndex = 0;
        }

        highlightActive();
        saveActiveIndex(activeIndex);
        setHash(activeIndex);

        setTimeout(() => {
            scrollToBookmarkPosition(activeIndex);
        }, 100);

        window.addEventListener('scroll', () => {
            syncPosition();
            hideSetButton();
        }, { passive: true });

        window.addEventListener('resize', syncPosition, { passive: true });
        window.addEventListener('hashchange', onHashChange);

        syncPosition();
    }

    // Запуск скрипта
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
