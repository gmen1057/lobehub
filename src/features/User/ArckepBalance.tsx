'use client';

import { Tooltip } from 'antd';
import { createStyles } from 'antd-style';
import { Wallet } from 'lucide-react';
import { memo } from 'react';
import useSWR from 'swr';

const fetcher = (url: string) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error('Failed to fetch balance');
    return res.json();
  });

const useStyles = createStyles(({ css, token }) => ({
  container: css`
    cursor: pointer;
    user-select: none;

    display: inline-flex;
    gap: 6px;
    align-items: center;

    padding-block: 4px;
    padding-inline: 12px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: 20px;

    font-size: 13px;
    font-weight: 500;
    color: ${token.colorText};

    background: ${token.colorFillTertiary};

    transition: all 0.2s ease-in-out;

    &:hover {
      transform: translateY(-1px);
      border-color: ${token.colorBorder};
      background: ${token.colorFillSecondary};
    }

    &:active {
      transform: translateY(0);
    }
  `,
  mobileContainer: css`
    cursor: pointer;
    user-select: none;

    display: inline-flex;
    gap: 4px;
    align-items: center;

    padding-block: 4px;
    padding-inline: 8px;
    border: none;
    border-radius: 12px;

    font-size: 12px;
    font-weight: 500;
    color: ${token.colorText};

    background: ${token.colorFillTertiary};
  `,
  icon: css`
    color: ${token.colorPrimary};
  `,
}));

interface ArckepBalanceProps {
  mobile?: boolean;
}

const ArckepBalance = memo<ArckepBalanceProps>(({ mobile }) => {
  const { styles } = useStyles();
  const { data, error } = useSWR('/api/arckep/balance', fetcher, {
    refreshInterval: 15000,
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });

  if (error || !data || typeof data.balance !== 'number') {
    return null;
  }

  const balance = data.balance;
  const isCorporate = data.is_corporate;
  const corpName = data.corporate_name;

  const tooltipTitle = isCorporate
    ? `Корпоративный баланс (${corpName}): ${balance.toFixed(2)} ₽`
    : `Баланс Студии ИИ: ${balance.toFixed(2)} ₽`;

  const handleClick = () => {
    window.open('https://arckep.ru/settings#balance', '_blank');
  };

  const content = (
    <div className={mobile ? styles.mobileContainer : styles.container} onClick={handleClick}>
      <Wallet className={styles.icon} size={mobile ? 12 : 14} />
      <span>{balance.toFixed(0)} ₽</span>
    </div>
  );

  if (mobile) {
    return content;
  }

  return (
    <Tooltip placement="bottom" title={tooltipTitle}>
      {content}
    </Tooltip>
  );
});

ArckepBalance.displayName = 'ArckepBalance';

export default ArckepBalance;
