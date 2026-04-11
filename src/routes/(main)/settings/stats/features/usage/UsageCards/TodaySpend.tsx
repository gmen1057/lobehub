'use client';

import dayjs from 'dayjs';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import Statistic from '@/components/Statistic';
import StatisticCard from '@/components/StatisticCard';
import TitleWithPercentage from '@/components/StatisticCard/TitleWithPercentage';
import { ARCKEP_CURRENCY_SYMBOL, usdToRub } from '@/const/arckepPricing';
import { type UsageLog } from '@/types/usage/usageRecord';
import { formatNumber } from '@/utils/format';

import { type UsageChartProps } from '../../../types';

const computeSpend = (
  data: UsageLog[],
): {
  today: number | string;
  todayRaw: number;
  yesterday: number | string;
  yesterdayRaw: number;
} => {
  if (!data || data?.length === 0) return { today: 0, todayRaw: 0, yesterday: 0, yesterdayRaw: 0 };

  const todayUsd = data.find((log) => dayjs.utc(log.day).isToday())?.totalSpend ?? 0;
  const yesterdayUsd = data.find((log) => dayjs.utc(log.day).isYesterday())?.totalSpend ?? 0;

  const todayRub = usdToRub(todayUsd);
  const yesterdayRub = usdToRub(yesterdayUsd);

  return {
    today: formatNumber(todayRub),
    todayRaw: todayRub,
    yesterday: formatNumber(yesterdayRub),
    yesterdayRaw: yesterdayRub,
  };
};

const TodaySpend = memo<UsageChartProps>(({ data, isLoading }) => {
  const { t } = useTranslation('auth');

  const { today, yesterday, todayRaw, yesterdayRaw } = computeSpend(data || []);

  return (
    <StatisticCard
      loading={isLoading}
      statistic={{
        description: <Statistic title={t('usage.cards.today.yesterday')} value={yesterday} />,
        precision: 2,
        suffix: ` ${ARCKEP_CURRENCY_SYMBOL}`,
        value: today,
      }}
      title={
        <TitleWithPercentage
          count={todayRaw}
          prvCount={yesterdayRaw}
          title={t('usage.cards.today.title')}
        />
      }
    />
  );
});

export default TodaySpend;
