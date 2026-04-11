'use client';

import { ActionIcon, DropdownMenu, Flexbox, Icon, type MenuProps } from '@lobehub/ui';
import { CircleHelp, Settings, Settings2 } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';

import ThemeButton from '@/features/User/UserPanel/ThemeButton';
import { useNavLayout } from '@/hooks/useNavLayout';
import { useUserStore } from '@/store/user';
import { userGeneralSettingsSelectors } from '@/store/user/slices/settings/selectors';

/**
 * arckep: upstream Footer had entries for LobeHub Docs, Feedback, Discord,
 * Changelog, GitHub star, Product Hunt card, and /eval (Evaluation Lab).
 * All stripped — we expose only the settings entry that points to our own
 * /settings. ChangelogModal/HighlightNotification/ProductHunt logic removed
 * (upstream campaign dates are already past, and we don't need analytics
 * tracking for banners we don't render).
 */
const Footer = memo(() => {
  const { t } = useTranslation('common');
  const { footer } = useNavLayout();
  const isDevMode = useUserStore((s) => userGeneralSettingsSelectors.config(s).isDevMode);
  const location = useLocation();
  const isSettingsPage = location.pathname.startsWith('/settings');

  const helpMenuItems: MenuProps['items'] = useMemo(
    () =>
      footer.showSettingsEntry && !isDevMode
        ? [
            {
              icon: <Icon icon={Settings2} />,
              key: 'setting',
              label: <Link to="/settings">{t('userPanel.setting')}</Link>,
            },
          ]
        : [],
    [footer.showSettingsEntry, isDevMode, t],
  );

  return (
    <>
      {footer.layout === 'expanded' ? (
        <Flexbox horizontal align={'center'} gap={2} justify={'space-between'} padding={8}>
          <Flexbox horizontal align={'center'} flex={1} gap={2}>
            <DropdownMenu items={helpMenuItems} placement="topLeft">
              <ActionIcon aria-label={t('userPanel.help')} icon={CircleHelp} size={16} />
            </DropdownMenu>
          </Flexbox>
          <ThemeButton placement={'topCenter'} size={16} />
        </Flexbox>
      ) : (
        <Flexbox horizontal align={'center'} gap={2} padding={8}>
          <DropdownMenu items={helpMenuItems} placement="topLeft">
            <ActionIcon aria-label={t('userPanel.help')} icon={CircleHelp} size={16} />
          </DropdownMenu>
          {isDevMode && !isSettingsPage && (
            <Link to="/settings">
              <ActionIcon aria-label={t('userPanel.setting')} icon={Settings} size={16} />
            </Link>
          )}
        </Flexbox>
      )}
    </>
  );
});

export default Footer;
