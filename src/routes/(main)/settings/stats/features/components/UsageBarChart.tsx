import { type BarChartProps } from '@lobehub/charts';
import { BarChart, ChartTooltipFrame, ChartTooltipRow } from '@lobehub/charts';
import { Flexbox, Text } from '@lobehub/ui';
import { Divider } from 'antd';

import { ARCKEP_CURRENCY_SYMBOL } from '@/const/arckepPricing';
import { formatNumber, formatTokenNumber } from '@/utils/format';

// arckep: wrap spend formatter to show RUB suffix in chart tooltips/axis
const formatSpend = (num: number) => `${formatNumber(num, 2)} ${ARCKEP_CURRENCY_SYMBOL}`;

interface UsageBarChartProps extends BarChartProps {
  showType: 'spend' | 'token';
}

export const UsageBarChart = ({ ...props }: UsageBarChartProps) => (
  <BarChart
    {...props}
    customTooltip={({ active, payload, label }) => {
      if (active && payload) {
        const sum = payload.reduce(
          (acc: number, cur: any) => (typeof cur.value === 'number' ? acc + cur.value : acc),
          0,
        );
        return (
          <ChartTooltipFrame>
            <Flexbox horizontal justify={'space-between'} paddingBlock={8} paddingInline={16}>
              <Text ellipsis as={'p'} style={{ margin: 0 }}>
                {label}
              </Text>
              {sum !== 0 && (
                <span style={{ fontWeight: 'bold' }}>
                  {props.showType === 'spend' ? formatSpend(sum) : formatTokenNumber(sum)}
                </span>
              )}
            </Flexbox>
            {sum !== 0 && (
              <>
                <Divider style={{ margin: 0 }} />
                <Flexbox
                  gap={4}
                  paddingBlock={8}
                  paddingInline={16}
                  style={{ flexDirection: 'column-reverse', marginTop: 4 }}
                >
                  {payload.map(({ value, color, name }: any, idx: number) =>
                    typeof value === 'number' && value > 0 ? (
                      <ChartTooltipRow
                        color={color}
                        key={`id-${idx}`}
                        name={name}
                        value={
                          props.showType === 'spend' ? formatSpend(value) : formatTokenNumber(value)
                        }
                      />
                    ) : null,
                  )}
                </Flexbox>
              </>
            )}
          </ChartTooltipFrame>
        );
      }
      return null;
    }}
    valueFormatter={(num) =>
      props.showType === 'spend' ? formatSpend(num) : formatTokenNumber(num)
    }
  />
);
