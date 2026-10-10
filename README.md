# 🎵 Recro — Minimalist Web Audio Player & Smart Wave

[![Angular](https://img.shields.io/badge/Angular-21-dd0031.svg?style=flat-square&logo=angular)](https://angular.dev)
[![Rust](https://img.shields.io/badge/Rust-Axum-dea584.svg?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-Audio_Engine-007808.svg?style=flat-square&logo=ffmpeg)](https://ffmpeg.org)
[![PWA](https://img.shields.io/badge/PWA-Ready-5A0FC8.svg?style=flat-square)](https://web.dev/progressive-web-apps/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

**Recro** — современный, быстрый аудиоплеер со встроенным алгоритмом «Моя Волна», караоке-текстами песен, каталогом радиостанций, мультиплатформенным поиском и оффлайн-режимом. Без рекламы и подписок: аудиопотоки обрабатываются напрямую высокопроизводительным бэкендом на Rust и транскодируются в реальном времени.

---

## 🌐 Рабочие ссылки (Production)

- **Веб-версия (Frontend):** [https://signal-frontend-production-a944.up.railway.app](https://signal-frontend-production-a944.up.railway.app)
- **API Сервер (Backend):** [https://signal-audio-backend-production.up.railway.app](https://signal-audio-backend-production.up.railway.app)

---

## 📸 Интерфейс приложения

| Десктопная версия (Web / PWA) | Мобильная адаптация |
| :---: | :---: |
| <img src="docs/screenshots/desktop_preview.png" alt="Recro Desktop Player" width="550"/> | <img src="docs/screenshots/mobile_preview.png" alt="Recro Mobile Player" width="220"/> |

---

## ✨ Ключевые возможности

### 🌊 Моя Волна (Smart Wave 2.0)
- **100% изоляция языковых потоков**: при воспроизведении зарубежных композиций подбираются строго иностранные треки; при переключении на русскую музыку волна удерживает 100% русскоязычный контент.
- **Векторная модель косинусного сходства**: обучающийся вектор предпочтений пользователя (темп, энергия, акустичность, жанровые паттерны). Релевантность проверяется строгим порогом сходства ($\ge 0.38$).
- **Пул качественных открытий (`onlineDiscoveryPool`)**: сохранение радио артистов в буфере памяти, гарантирующее студийные треки без перехода в поисковый мусор и компиляции.
- **Сбалансированный режим (Balanced)**: умное чередование треков из медиатеки с подходящими онлайн-находками.

### 🎤 Синхронизированные тексты песен (Karaoke & Lyrics)
- Автоматический поиск караоке-текстов в реальном времени через базы LRCLIB, NetEase Cloud Music и Kugou.
- Плавная прокрутка текущей строчки под тайминг воспроизведения.

### ⚡ Мультиплатформенный поиск и стриминг
- **Deezer Radio & Search**: студийное аудио и официальные релизы.
- **SoundCloud**: быстрый поиск и стриминг инди-релизов, ремиксов и электронных треков.
- **YouTube**: интеграция и извлечение треков без блокировок.
- **Онлайн-радио**: каталог станций с фильтрацией и возможностью добавлять свои потоки.

### 📥 Оффлайн-режим и PWA
- Сохранение треков в локальное хранилище браузера (IndexedDB) в один клик.
- Полноценное воспроизведение загруженной музыки без доступа к интернету.
- Установка на мобильные устройства и десктоп в формате Progressive Web App.

### ☁️ Облачная синхронизация и безопасность
- Синхронизация библиотеки, плейлистов, истории прослушиваний и настроек волны.
- Авторизация по логину/паролю (хэширование bcrypt) или через Google OAuth.
- Защита от SSRF, брутфорса, DoS (Rate Limiting, семафоры потоков) и строгие security-заголовки.

---

## 📱 Поддерживаемые платформы

| Платформа | Формат работы | Особенности |
| :--- | :--- | :--- |
| **Android** | Браузер / PWA | Фоновое воспроизведение, управление в шторке, оффлайн |
| **iOS / iPadOS** | Safari / PWA («На экран "Домой"») | Управление на экране блокировки, оффлайн |
| **Windows** | Chrome, Edge, Firefox, Brave | Мультимедиа-клавиши клавиатуры, PWA-окно |
| **macOS** | Safari, Chrome, Firefox | Touch Bar, Media Keys, Command Center |
| **Linux** | Любой современный браузер | Управление через MPRIS / хоткеи |

---

## 🚀 Быстрый запуск через Docker Compose

```bash
git clone https://github.com/Ren4ik7284/Recro.git recro
cd recro

docker compose up --build -d
```

- **Frontend:** `http://localhost:4200`
- **Backend:** `http://localhost:8085`

---

## 🛠️ Запуск для разработки

### 1. Системные требования
- **Node.js** 20+ и **npm**
- **Rust** и **Cargo**
- **FFmpeg** и **yt-dlp**

### 2. Запуск бэкенда (Rust)
```bash
cd backend
cargo run
```

### 3. Запуск фронтенда (Angular)
```bash
cd frontend
npm install
npm start
```

---

## ⚙️ Структура проекта

```
recro/
├── backend/                  # Сервер на Rust (Axum, SQLite, FFmpeg)
│   ├── src/
│   │   ├── handlers/         # Обработчики API (поток, поиск, караоке, библиотека)
│   │   ├── auth.rs           # Аутентификация (Bcrypt + JWT + Google OAuth)
│   │   ├── security.rs       # Защита от SSRF и Rate Limiting
│   │   ├── soundcloud.rs     # Клиент интеграции SoundCloud API v2
│   │   └── main.rs           # Сервер Axum, CORS, семафоры и middleware
│   └── Cargo.toml            # Конфигурация зависимостей Rust
│
├── frontend/                 # Клиентское SPA-приложение (Angular 21)
│   ├── src/app/
│   │   ├── components/       # Компоненты UI (плеер, караоке, медиатека, волна)
│   │   ├── services/         # Сервисы (аудио, рекомендации волны, оффлайн)
│   │   ├── models/           # Модели данных
│   │   └── app.ts            # Главный компонент приложения
│   └── package.json          # Зависимости фронтенда
│
├── docker-compose.yml        # Оркестрация контейнеров
└── README.md                 # Документация проекта
```

---

## 📄 Лицензия

Проект распространяется под лицензией **MIT**. Подробности в файле `LICENSE`.
