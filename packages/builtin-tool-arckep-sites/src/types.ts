export const ArckepSitesIdentifier = 'arckep-sites';

export enum ArckepSitesApiName {
  connectTelegram = 'connectTelegram',
  generateImage = 'generateImage',
  getDesignBrief = 'getDesignBrief',
  listSites = 'listSites',
  listStyles = 'listStyles',
  readSite = 'readSite',
}

export interface GetDesignBriefParams {
  business?: string;
  style_id?: string;
}

export interface SiteStyleOption {
  emoji: string;
  id: string;
  name: string;
  palette: string[];
  tagline: string;
}

export interface DesignBriefResult {
  alternatives: SiteStyleOption[];
  brief: string;
  emoji: string;
  name: string;
  palette: string[];
  style_id: string;
  tagline: string;
}

export interface ListStylesParams {}

export interface ListStylesResult {
  styles: SiteStyleOption[];
}

/** pluginState of a getDesignBrief tool message — drives the in-chat gallery render */
export interface DesignBriefState {
  alternatives: SiteStyleOption[];
  emoji: string;
  name: string;
  palette: string[];
  style_id: string;
  tagline: string;
}

export interface ListSitesParams {}

export interface ReadSiteParams {
  site_id: number;
}

export interface GenerateImageParams {
  aspect_ratio?: 'landscape' | 'portrait' | 'square';
  prompt: string;
  quality?: 'high' | 'standard';
}

export interface GenerateImageResult {
  balance: number;
  cost: number;
  url: string;
}

export interface SiteSummary {
  /** Present only for site_kind="dashboard": source/columns/row_count/generated_at. */
  data_contract?: Record<string, any> | null;
  http_auth_enabled?: boolean;
  id: number;
  /** "landing" (default) | "dashboard". Backend-owned, may grow more kinds. */
  site_kind?: string | null;
  slug: string;
  status: string;
  title: string;
  url: string;
  version: number;
}

export interface ConnectTelegramResult {
  connected: boolean;
  url: string;
}
