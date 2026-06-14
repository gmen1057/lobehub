export const ArckepSitesIdentifier = 'arckep-sites';

export enum ArckepSitesApiName {
  generateImage = 'generateImage',
  listSites = 'listSites',
  readSite = 'readSite',
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
  id: number;
  slug: string;
  status: string;
  title: string;
  url: string;
  version: number;
}
