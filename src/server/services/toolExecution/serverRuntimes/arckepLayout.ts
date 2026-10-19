import {
  ArckepLayoutIdentifier,
  type CheckLayoutParams,
  type EditArtifactParams,
} from '@lobechat/builtin-tool-arckep-layout';
import { ArckepLayoutExecutionRuntime } from '@lobechat/builtin-tool-arckep-layout/executionRuntime';

import { createLayoutDeps } from '@/server/services/arckepLayout/deps';
import { ArckepLayoutService } from '@/server/services/arckepLayout/service';

import { resolveArckepUserId } from './arckepStudio';
import { type ServerRuntimeRegistration } from './types';

/**
 * Сверка письма с макетом PDF и правки артефакта кусками (arckep, 19.10.2026). Всю работу делает
 * `ArckepLayoutService` (src/server/services/arckepLayout): отрисовка в бэкенде студии, сравнение, короткие
 * круги правщика вне переписки. Здесь — только привязка к человеку и теме хода.
 */
export const arckepLayoutRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.userId || !context.serverDB) {
      throw new Error('userId and serverDB are required for ArcKep Layout execution');
    }
    const { parentMessageId, serverDB, topicId, userId } = context;
    const service = new ArckepLayoutService(
      createLayoutDeps(serverDB, userId, () => resolveArckepUserId(serverDB, userId)),
      { parentMessageId, topicId, userId },
    );

    return new ArckepLayoutExecutionRuntime({
      checkLayout: (params: CheckLayoutParams) => service.checkLayout(params),
      editArtifact: (params: EditArtifactParams) => service.editArtifact(params),
    });
  },
  identifier: ArckepLayoutIdentifier,
};
