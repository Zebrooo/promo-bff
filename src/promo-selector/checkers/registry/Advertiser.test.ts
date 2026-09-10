import { describe, expect, it } from 'vitest';
import { AdvertiserChecker, DEFAULT_WIZARD_LOOKBACK_DAYS, hasAdvertiserRule, needsAdvertiserWallet, wizardWindowDaysFor } from './Advertiser';
import type { AdvertiserSignal } from '../Checker';
import { makeCheckContext, makePromo } from '../../../test-utils';

const checker = new AdvertiserChecker();
const NOW = new Date('2026-09-09T12:00:00.000Z');
type Rule = NonNullable<ReturnType<typeof makePromo>['targeting']['advertiser']>;

const signal = (over: Partial<AdvertiserSignal> = {}): AdvertiserSignal => ({
  statuses: [],
  hasActive: false,
  lastLaunchedAt: null,
  spentKopecks: 0,
  budgetExhausted: false,
  wizardEvents: [],
  wizardWindowDays: 90,
  ...over,
});

function context(rule: Rule, over: Partial<Parameters<typeof makeCheckContext>[0]> = {}) {
  return makeCheckContext({
    promo: makePromo({ targeting: { advertiser: rule } }),
    isAuthorized: true,
    identityKind: 'account',
    now: NOW,
    advertiser: signal(),
    ...over,
  });
}

const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('hasAdvertiserRule / helpers', () => {
  it('true only for a real condition; modifiers and an empty status list do not count', () => {
    expect(hasAdvertiserRule(makePromo())).toBe(false);
    expect(hasAdvertiserRule(makePromo({ targeting: { advertiser: {} } }))).toBe(false);
    expect(hasAdvertiserRule(makePromo({ targeting: { advertiser: { launchedWithinDays: 30, wizardLookbackDays: 7, minSpentKopecks: 100 } } }))).toBe(false);
    expect(hasAdvertiserRule(makePromo({ targeting: { advertiser: { campaignStatuses: [] } } }))).toBe(false);
    for (const rule of [
      { campaignStatuses: ['active'] }, { hasActiveCampaign: false }, { everLaunched: true }, { abandonedWizard: true },
      { paidCampaigns: false }, { budgetExhausted: true }, { walletAtMostKopecks: 0 },
    ] as Rule[]) {
      expect(hasAdvertiserRule(makePromo({ targeting: { advertiser: rule } })), JSON.stringify(rule)).toBe(true);
    }
  });

  it('wizardWindowDaysFor: 0 without abandonedWizard, rule window or the default otherwise', () => {
    expect(wizardWindowDaysFor(makePromo())).toBe(0);
    expect(wizardWindowDaysFor(makePromo({ targeting: { advertiser: { everLaunched: true, wizardLookbackDays: 7 } } }))).toBe(0);
    expect(wizardWindowDaysFor(makePromo({ targeting: { advertiser: { abandonedWizard: true } } }))).toBe(DEFAULT_WIZARD_LOOKBACK_DAYS);
    expect(wizardWindowDaysFor(makePromo({ targeting: { advertiser: { abandonedWizard: false, wizardLookbackDays: 14 } } }))).toBe(14);
  });

  it('needsAdvertiserWallet only for walletAtMostKopecks', () => {
    expect(needsAdvertiserWallet(makePromo({ targeting: { advertiser: { walletAtMostKopecks: 0 } } }))).toBe(true);
    expect(needsAdvertiserWallet(makePromo({ targeting: { advertiser: { everLaunched: true } } }))).toBe(false);
  });
});

describe('AdvertiserChecker', () => {
  it('skips when no rule is configured (or only modifiers are set)', () => {
    expect(checker.shouldSkip(makeCheckContext())).toBe('no advertiser targeting');
    expect(checker.shouldSkip(context({ launchedWithinDays: 30 }))).toBe('no advertiser targeting');
    expect(checker.shouldSkip(context({ everLaunched: false }))).toBe(false);
  });

  it('fails closed for a guest and when the signal was not loaded', () => {
    expect(checker.check(context({ everLaunched: false }, { isAuthorized: false }))).toBe(false);
    expect(checker.check(context({ everLaunched: false }, { advertiser: undefined }))).toBe(false);
  });

  it('campaignStatuses: OR within the list, invalid (blank) entries fail the rule', () => {
    const s = signal({ statuses: ['paused', 'pending'] });
    expect(checker.check(context({ campaignStatuses: ['active', 'pending'] }, { advertiser: s }))).toBe(true);
    expect(checker.check(context({ campaignStatuses: ['active'] }, { advertiser: s }))).toBe(false);
    expect(checker.check(context({ campaignStatuses: ['pending', ''] }, { advertiser: s }))).toBe(false);
  });

  it('hasActiveCampaign matches the current active flag', () => {
    expect(checker.check(context({ hasActiveCampaign: true }, { advertiser: signal({ hasActive: true }) }))).toBe(true);
    expect(checker.check(context({ hasActiveCampaign: true }))).toBe(false);
    expect(checker.check(context({ hasActiveCampaign: false }))).toBe(true);
    expect(checker.check(context({ hasActiveCampaign: false }, { advertiser: signal({ hasActive: true }) }))).toBe(false);
  });

  it('everLaunched + launchedWithinDays: сегмент №1 «запускал, сейчас неактивна»', () => {
    const inactive = signal({ statuses: ['paused'], lastLaunchedAt: daysAgo(40) });
    expect(checker.check(context({ everLaunched: true, hasActiveCampaign: false }, { advertiser: inactive }))).toBe(true);
    expect(checker.check(context({ everLaunched: true, hasActiveCampaign: false }, { advertiser: signal({ hasActive: true, lastLaunchedAt: daysAgo(1) }) }))).toBe(false);
    expect(checker.check(context({ everLaunched: false }, { advertiser: inactive }))).toBe(false);
    expect(checker.check(context({ everLaunched: false }))).toBe(true);
    expect(checker.check(context({ everLaunched: true, launchedWithinDays: 90 }, { advertiser: inactive }))).toBe(true);
    expect(checker.check(context({ everLaunched: true, launchedWithinDays: 30 }, { advertiser: inactive }))).toBe(false);
    // Запускал, но дата запуска неизвестна ('' от агрегатора): everLaunched проходит, окно — нет.
    expect(checker.check(context({ everLaunched: true }, { advertiser: signal({ lastLaunchedAt: '' }) }))).toBe(true);
    expect(checker.check(context({ everLaunched: true, launchedWithinDays: 365 }, { advertiser: signal({ lastLaunchedAt: '' }) }))).toBe(false);
    expect(checker.check(context({ everLaunched: true, launchedWithinDays: 0 }, { advertiser: inactive }))).toBe(false);
  });

  it('abandonedWizard: последний старт в окне без отправки после него', () => {
    const abandoned = signal({ wizardEvents: [{ kind: 'start', at: daysAgo(3) }] });
    const submitted = signal({ wizardEvents: [{ kind: 'submit', at: daysAgo(2) }, { kind: 'start', at: daysAgo(3) }] });
    const reopened = signal({ wizardEvents: [{ kind: 'start', at: daysAgo(1) }, { kind: 'submit', at: daysAgo(2) }, { kind: 'start', at: daysAgo(3) }] });
    expect(checker.check(context({ abandonedWizard: true }, { advertiser: abandoned }))).toBe(true);
    expect(checker.check(context({ abandonedWizard: true }, { advertiser: submitted }))).toBe(false);
    expect(checker.check(context({ abandonedWizard: true }, { advertiser: reopened }))).toBe(true);
    expect(checker.check(context({ abandonedWizard: false }, { advertiser: submitted }))).toBe(true);
    expect(checker.check(context({ abandonedWizard: false }))).toBe(true);
    expect(checker.check(context({ abandonedWizard: true }))).toBe(false);
  });

  it('abandonedWizard: правило фильтрует события своим окном, а узко загруженные данные — fail closed', () => {
    const old = signal({ wizardEvents: [{ kind: 'start', at: daysAgo(20) }], wizardWindowDays: 30 });
    expect(checker.check(context({ abandonedWizard: true, wizardLookbackDays: 30 }, { advertiser: old }))).toBe(true);
    expect(checker.check(context({ abandonedWizard: true, wizardLookbackDays: 7 }, { advertiser: old }))).toBe(false);
    expect(checker.check(context({ abandonedWizard: false, wizardLookbackDays: 7 }, { advertiser: old }))).toBe(true);
    // Загрузили на 7 дней, правило просит дефолтные 30 → данных нет.
    expect(checker.check(context({ abandonedWizard: false }, { advertiser: signal({ wizardWindowDays: 7 }) }))).toBe(false);
    // Сегмент №2: заходил на форму и бросил, РК никогда не запускал.
    expect(checker.check(context({ abandonedWizard: true, everLaunched: false }, { advertiser: signal({ wizardEvents: [{ kind: 'start', at: daysAgo(1) }] }) }))).toBe(true);
  });

  it('paidCampaigns + minSpentKopecks', () => {
    expect(checker.check(context({ paidCampaigns: true }, { advertiser: signal({ spentKopecks: 1 }) }))).toBe(true);
    expect(checker.check(context({ paidCampaigns: true }))).toBe(false);
    expect(checker.check(context({ paidCampaigns: false }))).toBe(true);
    expect(checker.check(context({ paidCampaigns: false }, { advertiser: signal({ spentKopecks: 1 }) }))).toBe(false);
    expect(checker.check(context({ paidCampaigns: true, minSpentKopecks: 100000 }, { advertiser: signal({ spentKopecks: 100000 }) }))).toBe(true);
    expect(checker.check(context({ paidCampaigns: true, minSpentKopecks: 100000 }, { advertiser: signal({ spentKopecks: 99999 }) }))).toBe(false);
  });

  it('budgetExhausted matches the aggregate flag', () => {
    expect(checker.check(context({ budgetExhausted: true }, { advertiser: signal({ budgetExhausted: true }) }))).toBe(true);
    expect(checker.check(context({ budgetExhausted: true }))).toBe(false);
    expect(checker.check(context({ budgetExhausted: false }))).toBe(true);
  });

  it('a stale endsWithinDays key in a hand-edited pool is not a rule (поле убрано: у ad_campaigns нет даты окончания)', () => {
    const promo = makePromo({ targeting: { advertiser: { endsWithinDays: 7 } as never } });
    expect(hasAdvertiserRule(promo)).toBe(false);
    expect(checker.shouldSkip(makeCheckContext({ promo }))).toBe('no advertiser targeting');
  });

  it('walletAtMostKopecks: absent wallet = 0, failed fetch = fail closed', () => {
    expect(checker.check(context({ walletAtMostKopecks: 0 }))).toBe(true);
    expect(checker.check(context({ walletAtMostKopecks: 0 }, { walletBalanceKopecks: 0 }))).toBe(true);
    expect(checker.check(context({ walletAtMostKopecks: 0 }, { walletBalanceKopecks: 1 }))).toBe(false);
    expect(checker.check(context({ walletAtMostKopecks: 50000 }, { walletBalanceKopecks: 50000 }))).toBe(true);
    expect(checker.check(context({ walletAtMostKopecks: 50000 }, { walletBalanceKopecks: 50001 }))).toBe(false);
    expect(checker.check(context({ walletAtMostKopecks: 0 }, { walletBalanceUnavailable: true }))).toBe(false);
  });

  it('combines conditions with AND', () => {
    const rule: Rule = { everLaunched: true, hasActiveCampaign: false, paidCampaigns: true, walletAtMostKopecks: 0 };
    const s = signal({ statuses: ['paused'], lastLaunchedAt: daysAgo(10), spentKopecks: 500 });
    expect(checker.check(context(rule, { advertiser: s }))).toBe(true);
    expect(checker.check(context(rule, { advertiser: s, walletBalanceKopecks: 100 }))).toBe(false);
    expect(checker.check(context(rule, { advertiser: { ...s, hasActive: true } }))).toBe(false);
  });

  it('run(): a guest fails through the lifecycle wrapper, a non-targeted promo passes as skipped', async () => {
    await expect(checker.run(context({ everLaunched: false }, { isAuthorized: false }), {} as never)).resolves.toBe(false);
    await expect(checker.run(makeCheckContext(), {} as never)).resolves.toBe(true);
  });
});
