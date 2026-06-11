export const ArckepSitesIdentifier = 'arckep-sites';

export enum ArckepSitesApiName {
  listSites = 'listSites',
  readSite = 'readSite',
}

export interface ListSitesParams {}

export interface ReadSiteParams {
  site_id: number;
}

export interface SiteSummary {
  id: number;
  slug: string;
  status: string;
  title: string;
  url: string;
  version: number;
}
