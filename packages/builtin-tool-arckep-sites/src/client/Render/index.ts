import type { BuiltinRender } from '@lobechat/types';

import { ArckepSitesApiName } from '../../types';
import GetDesignBriefRender from './GetDesignBrief';
import ListStylesRender from './ListStyles';

/**
 * In-chat result UI for the «Мои сайты» tool. Only the style-related APIs get
 * custom renders (interactive gallery with palette swatches and pick buttons);
 * list/read/generate-image keep the default renderer.
 */
export const ArckepSitesRenders: Record<string, BuiltinRender> = {
  [ArckepSitesApiName.getDesignBrief]: GetDesignBriefRender as BuiltinRender,
  [ArckepSitesApiName.listStyles]: ListStylesRender as BuiltinRender,
};
