# AdvertiserChecker — ось таргетинга «Рекламодатель»

- **Дата:** 2026-09-09
- **Спека контракта:** promo-cabinet, `docs/superpowers/specs/2026-09-09-targeting-advertiser-design.md`
- **Кабинет:** Zebrooo/promo-cabinet#41 (форма, схема, нормализация — уже в проде)

## Что делает

Новый чекер `advertiser` (после `listings`, участвует в `skipCheckers`)
гейтит промо по блоку `promo.targeting.advertiser`: рекламные кампании
зрителя (`ad_campaigns` abkhaz-auto Supabase), мастер подачи РК
(`user_action_events`, `form_id = 'ad_campaign'`) и рекламный кошелёк
(`ledger_accounts`, `kind=liability` — тот же, что читает BalanceChecker).

| Поле правила | Что проверяется |
| --- | --- |
| `campaignStatuses` | есть РК хотя бы в одном из статусов (ИЛИ); пустая строка в списке = невалидное правило → fail |
| `hasActiveCampaign` | есть / нет РК со `status = 'active'` |
| `everLaunched` (+ `launchedWithinDays`) | запускалась ли хоть одна РК: статус из `LAUNCHED_STATUSES` (`active, paused, completed, finished, ended, stopped`) **или** `spent_kopecks > 0`; дата запуска = `starts_at` → `updated_at` → `created_at`, максимум по запускавшимся |
| `abandonedWizard` (+ `wizardLookbackDays`, дефолт 30) | последний `form_start` в окне не закрыт `form_submit_success` после него |
| `paidCampaigns` (+ `minSpentKopecks`) | `sum(spent_kopecks) > 0`, и ≥ порога при «платил» |
| `budgetExhausted` | есть запускавшаяся РК с `spent ≥ total_budget`, или `spent_today ≥ daily_budget` за сегодняшнюю дату МСК (`moscowDateKey`, как у `dailyBudgetCheck` аукциона) |
| `endsWithinDays` | среди активных РК ближайший `ends_at ≥ now` попадает в `[now, now + N дней]` |
| `walletAtMostKopecks` | `ctx.walletBalanceKopecks ?? 0 ≤ N`; сбой чтения баланса → fail closed, отсутствие счёта = 0 |

Между условиями — И. Гость (`isAuthorized = false`) не проходит никогда;
сигнал не загружен (нет account-идентичности, Supabase недоступна) →
fail closed для всех advertiser-промо, остальная очередь не затронута.

## Как устроено

- `services/advertiser-signal-service.ts` — читает `ad_campaigns`
  (`advertiser_id = eq.<user>`, `select=*`, защитный маппинг, как в
  campaign-review-service) и, если какому-то промо в очереди нужен мастер,
  `user_action_events` (`event_name in (form_start, form_submit_success)`,
  `props->>form_id = ad_campaign`, `created_at ≥ now − окно`). Чистая
  агрегация `computeAdvertiserSignal` → `AdvertiserSignal` (только агрегаты,
  чекер сырых строк не видит). Таймаут 300 мс, TTL-кэш 60 с по
  `(userId, окно)`. Без конфига aaSupabase — пустой сигнал (dev/тесты).
  RPC на стороне витрины **не нужен** — в отличие от предположения спеки
  кабинета, всё считается в BFF по двум узким выборкам.
- `models/select-promo/handle.ts` — `loadAdvertiserForSelection`: читает
  сигнал только когда в очереди есть advertiser-правило и зритель —
  доказанный аккаунт; окно мастера = максимум по очереди (каждый чекер
  фильтрует своим). Идёт параллельно с search/wallet/behavior. Кошелёк для
  `walletAtMostKopecks` подтягивает `loadWalletDataForSelection` тем же
  чтением, что для `targeting.balance`.
- `checkers/registry/Advertiser.ts` — сам чекер + `hasAdvertiserRule`
  (зеркало `hasAdvertiserCriteria` кабинета: модификаторы и пустой список
  статусов правило не включают).
- `catalogue-schema.ts` — `advertiserTargetingSchema` (зеркало кабинета без
  refine'ов на противоречия: противоречивое правило просто никому не
  совпадёт); пуш-рассылки получают поле через `promoTargetingSchema`.
- `server.ts` — `createAdvertiserSignalService(config.aaSupabase)`.

## Что нужно от витрины (abkhaz-auto)

`CampaignEditor` (`lk/reklama`) должен слать `form_start` и
`form_submit_success` с `form_id = 'ad_campaign'` в `user_action_events`
(таксономия — `docs/event-taxonomy.md` кабинета). Пока событий нет,
`abandonedWizard: true` никому не совпадёт; остальные условия оси работают.

Если реальный enum `ad_campaigns.status` содержит другие «после запуска»
статусы — дополнить `LAUNCHED_STATUSES` в advertiser-signal-service.ts.
