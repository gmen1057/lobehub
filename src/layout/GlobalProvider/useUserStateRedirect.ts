'use client';

import { useCallback } from 'react';

import { isDesktop } from '@/const/version';
import { type UserInitializationState } from '@/types/user';

export const useDesktopUserStateRedirect = () => {
  // Desktop onboarding redirect is now handled by main process (BrowserManager)
  // No need to check localStorage here
  return useCallback(() => {}, []);
};

export const useWebUserStateRedirect = () =>
  useCallback((_state: UserInitializationState) => {
    // arckep fork: onboarding flow disabled — bridge auth covers user setup.
    // Upstream would redirect to '/onboarding' here (absolute path, without
    // basePath '/chat'), which 404s on the arckep.ru host and traps users
    // in a loop. See KNOWN_ISSUES.md (image-studio) 2026-05-24.
    return;
  }, []);

export const useUserStateRedirect = () => {
  const desktopRedirect = useDesktopUserStateRedirect();
  const webRedirect = useWebUserStateRedirect();

  return useCallback(
    (state: UserInitializationState) => {
      const redirect = isDesktop ? desktopRedirect : webRedirect;
      redirect(state);
    },
    [desktopRedirect, webRedirect],
  );
};
