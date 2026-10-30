# Pending acceptance — installed notifier 0.6.0

31.10.2026, 01:34 МСК. Задача `codex-wake-false-negative-dup`.

## Версия и происхождение

- Runtime: `@agfpd/notifier-runtime@0.6.0`, tag `v0.6.0`, commit `b691a8456ca2e305d42331ad2d28173a3dda8bcc`.
- [CI: 400 тестов и typecheck](https://github.com/agfpd/notifier-runtime/actions/runs/41137260278) — success.
- [Publish](https://github.com/agfpd/notifier-runtime/actions/runs/41137264023) — success; опубликованный tarball SHA1 `8380d1ed12253fee79ee7dcc1d114624a5e7fbf0`.
- Штатная установка: `iapeer update-runtime notifier --force`; npm скачал tarball с HTTP 200/cache miss, self-config и restart обеих ролей успешны. Manifest — 0.6.0, `codesign --verify --strict` успешен, timer/watcher live.
- Installed notifier SHA256: `8bea24f18e8329eb8e187e6f73537d69d18c6e246a27a66c21901715d1f9d940`.
- Installed core 0.4.155 SHA256: `230552f04f4148b55c1214c200ee0b57ee7ec0f825d9efc233d761ccd907b77a`.
- Fixture `scripts/proof-installed-acceptance.ts` SHA256: `a807f760ddbe3a8a8004b7f0304de28fa072b47cc67eeb775b9abf4494691871`.

У npm metadata появился раньше tarball: первоначальные штатные установки получили 404. Промежуточная локальная установка с release-tag была затем заменена опубликованным пакетом через `--force`. Все шесть результатов ниже получены **после** этой замены и проверяют один и тот же installed hash, не candidate/source binary.

## Корреляция и рестарт

Запись сигнала сохраняет owner/id триггера, payload, исходную цепочку и cursor. Перед CLI-send внутри per-target lane записывается `submitting`; ответ `pending acceptance <deliveryId>` сохраняет custody и освобождает lane без retry/fallback. Событие от `core/iapeer-system` сначала сохраняется в отдельном durable inbox, затем сопоставляется по deliveryId и получателю. Актуальная конфигурация триггера для корреляции не нужна.

- `delivered`: снять запись без отправки.
- `failed`: однократно перейти к следующему звену сохранённой цепочки.
- `unresolved`: сохранить custody и отправить владельцу отдельную информационную тревогу с trigger/signal/delivery id, без original task. Task-fallback не запускается; late delivered снимает custody.

Cursor, custody, входящие события и checkpoint owner-notice переживают рестарт. Событие до ответа CLI, повторные/запоздавшие события, pending на fallback-звене, поздний delivered и авария между записью owner-notice и checkpoint дополнительно покрыты регрессиями.

## Живая приёмка

Использованы настоящие native Codex TUI, installed core/notifier и loopback provider в изолированных HOME/CODEX_HOME/IAPEER_ROOT/router/run-dir. Source imports sibling-репозитория iapeer только создают fixture; отправка, регистрация, native submit и процессы выполняются установленными бинарями. Для timer используется одноразовый check, для watcher — одноразовая stdout-строка: перезапуск script не генерирует новую бизнес-задачу.

| Роль | Сценарий | Native USER | Попытки task на primary | Доставок task в fallback | Информационных unresolved владельцу |
|---|---|---:|---:|---:|---:|
| timer | отказ до paste | 0 | 2 явных отказа | 1 | 0 |
| watcher | отказ до paste | 0 | 2 явных отказа | 1 | 0 |
| timer | pending → restart → delivered | 1 | 1 | 0 | 0 |
| watcher | pending → restart → delivered | 1 | 1 | 0 | 0 |
| timer | pending → restart → unresolved | 0 | 1 | 0 | 1 |
| watcher | pending → restart → unresolved | 0 | 1 | 0 | 1 |

Отказ — реальный `stop` получателя; notifier использует обычные два pre-paste отказа и доставляет fallback ровно один раз. Unit-тест отдельно проверяет событие `failed` и продвижение fallback → owner → backstop. Core сейчас не превращает отсутствие receipt после paste в `failed`.

Для delivered задержка создаётся native SessionStart hook; затем receipt появляется без повторной вставки. Для unresolved native процесс остановлен до submit и убит после pending; owner получает только информационную тревогу. Наблюдённый ноль USER в этом контролируемом fixture не используется как основание для replay в продукте.

Сопоставление deliveryId и смена hosting PID подтверждены во всех четырёх pending-сценариях:

| Роль / итог | DeliveryId | PID до → после |
|---|---|---|
| timer / delivered | `09a66cf2-a942-4554-826b-d91b29ed7bad` | 17882 → 18288 |
| watcher / delivered | `83123024-7de3-4cc9-93cd-ea4138751f45` | 17267 → 17564 |
| timer / unresolved | `4482d316-3ba1-4116-a176-5cd73cf03142` | 18078 → 18325 |
| watcher / unresolved | `d4725608-0cf8-4760-a527-82ab9a2e1bda` | 18077 → 18277 |

Первый refusal-прогон отбракован как ошибка измерения: canonical `/bin/cat` отображал один конверт дважды (tty echo + вывод cat). Fixture заменён raw stdin sink; **все шесть сценариев повторены**. В таблице только финальные `raw-*` результаты.

## Границы гарантии

- Native ingestion не доказывает завершение задачи или exactly-once внешних эффектов.
- У CLI core нет caller requestId. Crash/kill в `submitting` до получения deliveryId становится видимым unresolved без автоматического сопоставления и replay. Pending без итогового события 180 секунд также видим владельцу, не передаёт notifier право повторять задачу.
- Перед обновлением legacy pending-spool был пуст у обеих ролей. Старые `lost`/`flooded` записи не тронуты. Downgrade ниже 0.6.0 с custody-записями небезопасен: старый runtime не знает их семантики и re-drain может повторить задачу.
- Независимая повторная генерация одинаковой бизнес-задачи скриптом/расписанием не является повтором одного deliveryId. Скрипты watcher должны быть restart-tolerant.

## Артефакты и повторение

На хосте: `/Users/macmini/Projects/notifier-runtime/.iapeer/receipts/0.6.0/summary.json`, `deploy.txt`, `npm-artifact-provenance.txt`, `host-peers.json`, `raw-{timer,watcher}-{refusal,delivered,unresolved}/result.json` и native/pane/delivery logs. Изолированные процессы и рабочие каталоги удаляются fixture в `finally`; штатные профили не используются для тестовых триггеров.

Пример повторения из notifier-репозитория с соседним iapeer-репозиторием:

```sh
bun scripts/proof-installed-acceptance.ts --runtime codex --role watcher \
  --scenario delivered --artifacts /tmp/notifier-acceptance-proof
```
