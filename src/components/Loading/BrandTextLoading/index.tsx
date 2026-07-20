import { BRANDING_NAME } from '@lobechat/business-const';

import { ProductLogo } from '@/components/Branding';

import styles from './index.module.css';

interface BrandTextLoadingProps {
  debugId: string;
}

/**
 * Chat shell loading indicator. Always show Arckep branding — never the
 * upstream LobeHub wordmark (custom branding used to fall back to a bare
 * spinner, while the SPA HTML splash still showed LobeHub SVG).
 */
const BrandTextLoading = ({ debugId }: BrandTextLoadingProps) => {
  const showDebug = process.env.NODE_ENV === 'development' && debugId;

  return (
    <div className={styles.container}>
      <div aria-label={`Loading ${BRANDING_NAME}`} className={styles.brand} role="status">
        <ProductLogo size={40} type={'text'} />
      </div>
      {showDebug && (
        <div className={styles.debug}>
          <div className={styles.debugRow}>
            <code>Debug ID:</code>
            <span className={styles.debugTag}>
              <code>{debugId}</code>
            </span>
          </div>
          <div className={styles.debugHint}>only visible in development</div>
        </div>
      )}
    </div>
  );
};

export default BrandTextLoading;
