import { TRPCError } from '@trpc/server';
import debug from 'debug';
import { sha256 } from 'js-sha256';
import { z } from 'zod';

import { type ToolCallContent } from '@/libs/mcp';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { marketUserInfo, serverDatabase, telemetry } from '@/libs/trpc/lambda/middleware';
import { marketSDK, requireMarketAuth } from '@/libs/trpc/lambda/middleware/marketSDK';
import { isTrustedClientEnabled } from '@/libs/trusted-client';
import { FileS3 } from '@/server/modules/S3';
import { DiscoverService } from '@/server/services/discover';
import { FileService } from '@/server/services/file';
import { MarketService } from '@/server/services/market';
import {
  contentBlocksToString,
  processContentBlocks,
} from '@/server/services/mcp/contentProcessor';

import { scheduleToolCallReport } from './_helpers';

const log = debug('lobe-server:tools:market');

// ============================== Common Procedure ==============================
const marketToolProcedure = authedProcedure
  .use(serverDatabase)
  .use(telemetry)
  .use(marketUserInfo)
  .use(async ({ ctx, next }) => {
    const { UserModel } = await import('@/database/models/user');
    const userModel = new UserModel(ctx.serverDB, ctx.userId);

    return next({
      ctx: {
        discoverService: new DiscoverService({
          accessToken: ctx.marketAccessToken,
          userInfo: ctx.marketUserInfo,
        }),
        fileService: new FileService(ctx.serverDB, ctx.userId),
        marketService: new MarketService({
          accessToken: ctx.marketAccessToken,
          userInfo: ctx.marketUserInfo,
        }),
        userModel,
      },
    });
  });

// ============================== LobeHub Skill Procedures ==============================
/**
 * LobeHub Skill procedure with SDK and optional auth
 * Used for routes that may work without auth (like listing providers)
 */
const lobehubSkillBaseProcedure = authedProcedure
  .use(serverDatabase)
  .use(telemetry)
  .use(marketUserInfo)
  .use(marketSDK);

/**
 * LobeHub Skill procedure with required auth
 * Used for routes that require user authentication
 */
const lobehubSkillAuthProcedure = lobehubSkillBaseProcedure.use(requireMarketAuth);

// ============================== Schema Definitions ==============================

// Schema for metadata that frontend needs to pass (for cloud MCP reporting)
const metaSchema = z
  .object({
    customPluginInfo: z
      .object({
        avatar: z.string().optional(),
        description: z.string().optional(),
        name: z.string().optional(),
      })
      .optional(),
    isCustomPlugin: z.boolean().optional(),
    sessionId: z.string().optional(),
    version: z.string().optional(),
  })
  .optional();

// Schema for sandbox tool execution request
const execInSandboxSchema = z.object({
  params: z.record(z.any()),
  toolName: z.string(),
  topicId: z.string(),
  userId: z.string().optional(), // Optional: fallback to ctx.userId if not provided
});

// Schema for export and upload file (combined operation)
const exportAndUploadFileSchema = z.object({
  filename: z.string(),
  path: z.string(),
  topicId: z.string(),
});

// Schema for cloud MCP endpoint call
const callCloudMcpEndpointSchema = z.object({
  apiParams: z.record(z.any()),
  identifier: z.string(),
  meta: metaSchema,
  toolName: z.string(),
});

// ============================== Type Exports ==============================
export type ExecInSandboxInput = z.infer<typeof execInSandboxSchema>;
/** @deprecated Use ExecInSandboxInput */
export type CallCodeInterpreterToolInput = ExecInSandboxInput;
export type ExportAndUploadFileInput = z.infer<typeof exportAndUploadFileSchema>;

export interface CallToolResult {
  error?: {
    message: string;
    name?: string;
  };
  result: any;
  sessionExpiredAndRecreated?: boolean;
  success: boolean;
}

export interface ExportAndUploadFileResult {
  error?: {
    message: string;
  };
  fileId?: string;
  filename: string;
  mimeType?: string;
  size?: number;
  success: boolean;
  url?: string;
}

// ============================== Sandbox Handler (E2B proxy) ==============================

const E2B_GATEWAY_URL = process.env.E2B_GATEWAY_URL || 'http://127.0.0.1:8410/mcp/e2b-sandbox';

/**
 * Proxy sandbox calls to our self-hosted E2B gateway instead of LobeHub cloud.
 * Handles execCode, execScript, runCommand by forwarding Python code to E2B.
 */
const execInSandboxHandler = async ({
  input,
}: {
  ctx: { fileService: FileService; marketService: MarketService; serverDB: any; userId: string };
  input: ExecInSandboxInput;
}): Promise<CallToolResult> => {
  const { toolName, params } = input;

  log('execInSandbox (E2B proxy): tool=%s', toolName);

  try {
    // Extract code from various tool param formats
    let code = '';
    if (toolName === 'execCode' || toolName === 'executeCode') {
      code = params.code || params.script || '';
    } else if (toolName === 'execScript') {
      code = params.code || params.script || params.command || '';
    } else if (toolName === 'runCommand') {
      // Shell commands — wrap in subprocess
      const cmd = params.command || '';
      code = `import subprocess; r = subprocess.run(${JSON.stringify(cmd)}, shell=True, capture_output=True, text=True); print(r.stdout); print(r.stderr) if r.stderr else None`;
    } else {
      // For any other sandbox tool, try to extract code
      code = params.code || params.script || params.command || JSON.stringify(params);
    }

    if (!code) {
      return {
        error: { message: 'No code provided', name: 'ValidationError' },
        result: null,
        sessionExpiredAndRecreated: false,
        success: false,
      };
    }

    // Call our E2B MCP gateway
    const response = await fetch(E2B_GATEWAY_URL, {
      body: JSON.stringify({
        id: Date.now(),
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          arguments: { code, install_packages: params.packages || params.install_packages },
          name: 'execute_code',
        },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
    });

    const data = (await response.json()) as any;

    if (data.error) {
      return {
        error: { message: data.error.message, name: 'E2BError' },
        result: null,
        sessionExpiredAndRecreated: false,
        success: false,
      };
    }

    const text = data.result?.content?.[0]?.text || '';

    return {
      result: { output: text, success: true },
      sessionExpiredAndRecreated: false,
      success: true,
    };
  } catch (error) {
    log('execInSandbox E2B error: %O', error);

    return {
      error: {
        message: (error as Error).message,
        name: (error as Error).name,
      },
      result: null,
      sessionExpiredAndRecreated: false,
      success: false,
    };
  }
};

// ============================== Router ==============================
export const marketRouter = router({
  // ============================== Cloud MCP Gateway ==============================
  callCloudMcpEndpoint: marketToolProcedure
    .input(callCloudMcpEndpointSchema)
    .mutation(async ({ input, ctx }) => {
      log('callCloudMcpEndpoint input: %O', input);

      const startTime = Date.now();
      let success = true;
      let errorCode: string | undefined;
      let errorMessage: string | undefined;
      let result: { content: string; state: any; success: boolean } | undefined;

      try {
        // Check if trusted client is enabled - if so, we don't need user's accessToken
        const trustedClientEnabled = isTrustedClientEnabled();

        let userAccessToken: string | undefined;

        if (!trustedClientEnabled) {
          // Query user_settings to get market.accessToken only if trusted client is not enabled
          const userState = await ctx.userModel.getUserState(async () => ({}));
          userAccessToken = userState.settings?.market?.accessToken;

          log('callCloudMcpEndpoint: userAccessToken exists=%s', !!userAccessToken);

          if (!userAccessToken) {
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message: 'User access token not found. Please sign in to Market first.',
            });
          }
        } else {
          log('callCloudMcpEndpoint: using trusted client authentication');
        }

        const cloudResult = await ctx.discoverService.callCloudMcpEndpoint({
          apiParams: input.apiParams,
          identifier: input.identifier,
          toolName: input.toolName,
          userAccessToken,
        });
        const cloudResultContent = (cloudResult?.content ?? []) as ToolCallContent[];

        // Format the cloud result to MCPToolCallResult format
        // Process content blocks (upload images, etc.)
        const newContent =
          cloudResult?.isError || !ctx.fileService
            ? cloudResultContent
            : await processContentBlocks(cloudResultContent, ctx.fileService);

        // Convert content blocks to string
        const content = contentBlocksToString(newContent);
        const state = { ...cloudResult, content: newContent };

        result = { content, state, success: true };
        return result;
      } catch (error) {
        success = false;
        const err = error as Error;
        errorCode = 'CALL_FAILED';
        errorMessage = err.message;

        log('Error calling cloud MCP endpoint: %O', error);

        // Re-throw TRPCError as-is
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to call cloud MCP endpoint',
        });
      } finally {
        scheduleToolCallReport({
          errorCode,
          errorMessage,
          identifier: input.identifier,
          marketAccessToken: ctx.marketAccessToken,
          mcpType: 'cloud',
          meta: input.meta,
          requestPayload: input.apiParams,
          result,
          startTime,
          success,
          telemetryEnabled: ctx.telemetryEnabled,
          toolName: input.toolName,
        });
      }
    }),

  /** @deprecated Use execInSandbox instead. Will be removed in a future version. */
  callCodeInterpreterTool: marketToolProcedure
    .input(execInSandboxSchema)
    .mutation(({ input, ctx }) => execInSandboxHandler({ ctx, input })),

  // ============================== Sandbox Execution ==============================
  execInSandbox: marketToolProcedure
    .input(execInSandboxSchema)
    .mutation(({ input, ctx }) => execInSandboxHandler({ ctx, input })),

  // ============================== LobeHub Skill ==============================
  /**
   * Call a LobeHub Skill tool
   */
  connectCallTool: lobehubSkillAuthProcedure
    .input(
      z.object({
        args: z.record(z.any()).optional(),
        provider: z.string(),
        toolName: z.string(),
        topicId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { provider, toolName, args, topicId } = input;
      log('connectCallTool: provider=%s, tool=%s, topicId=%s', provider, toolName, topicId);
      try {
        const response = await ctx.marketSDK.skills.callTool(provider, {
          args: args || {},
          tool: toolName,
          // @ts-ignore
          topicId,
        });

        log('connectCallTool response: %O', response);

        return {
          data: response.data,
          success: response.success,
        };
      } catch (error) {
        const errorMessage = (error as Error).message;
        log('connectCallTool error: %s', errorMessage);

        if (errorMessage.includes('NOT_CONNECTED')) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Provider not connected. Please authorize first.',
          });
        }

        if (errorMessage.includes('TOKEN_EXPIRED')) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Token expired. Please re-authorize.',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to call tool: ${errorMessage}`,
        });
      }
    }),

  /**
   * Get all connections health status
   */
  connectGetAllHealth: lobehubSkillAuthProcedure.query(async ({ ctx }) => {
    log('connectGetAllHealth');

    try {
      const response = await ctx.marketSDK.connect.getAllHealth();
      return {
        connections: response.connections || [],
        summary: response.summary,
      };
    } catch (error) {
      log('connectGetAllHealth error: %O', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to get connections health: ${(error as Error).message}`,
      });
    }
  }),

  /**
   * Get authorize URL for a provider
   * This calls the SDK's authorize method which generates a secure authorization URL
   */
  connectGetAuthorizeUrl: lobehubSkillAuthProcedure
    .input(
      z.object({
        provider: z.string(),
        redirectUri: z.string().optional(),
        scopes: z.array(z.string()).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      log('connectGetAuthorizeUrl: provider=%s', input.provider);

      try {
        const response = await ctx.marketSDK.connect.authorize(input.provider, {
          redirect_uri: input.redirectUri,
          scopes: input.scopes,
        });

        return {
          authorizeUrl: response.authorize_url,
          code: response.code,
          expiresIn: response.expires_in,
        };
      } catch (error) {
        log('connectGetAuthorizeUrl error: %O', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to get authorize URL: ${(error as Error).message}`,
        });
      }
    }),

  /**
   * Get connection status for a provider
   */
  connectGetStatus: lobehubSkillAuthProcedure
    .input(z.object({ provider: z.string() }))
    .query(async ({ input, ctx }) => {
      log('connectGetStatus: provider=%s', input.provider);

      try {
        const response = await ctx.marketSDK.connect.getStatus(input.provider);
        return {
          connected: response.connected,
          connection: response.connection,
          icon: (response as any).icon,
          providerName: (response as any).providerName,
        };
      } catch (error) {
        log('connectGetStatus error: %O', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to get status: ${(error as Error).message}`,
        });
      }
    }),

  /**
   * List all user connections
   */
  connectListConnections: lobehubSkillBaseProcedure.query(async ({ ctx }) => {
    log('connectListConnections');

    try {
      const response = await ctx.marketSDK.connect.listConnections();
      // Debug logging
      log('connectListConnections raw response: %O', response);
      log('connectListConnections connections: %O', response.connections);
      return {
        connections: response.connections || [],
      };
    } catch (error) {
      log('connectListConnections error: %O', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to list connections: ${(error as Error).message}`,
      });
    }
  }),

  /**
   * List available providers (public, no auth required)
   */
  connectListProviders: lobehubSkillBaseProcedure.query(async ({ ctx }) => {
    log('connectListProviders');

    try {
      const response = await ctx.marketSDK.skills.listProviders();
      return {
        providers: response.providers || [],
      };
    } catch (error) {
      log('connectListProviders error: %O', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to list providers: ${(error as Error).message}`,
      });
    }
  }),

  /**
   * List tools for a provider
   */
  connectListTools: lobehubSkillBaseProcedure
    .input(z.object({ provider: z.string() }))
    .query(async ({ input, ctx }) => {
      log('connectListTools: provider=%s', input.provider);

      try {
        const response = await ctx.marketSDK.skills.listTools(input.provider);
        return {
          provider: input.provider,
          tools: response.tools || [],
        };
      } catch (error) {
        log('connectListTools error: %O', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to list tools: ${(error as Error).message}`,
        });
      }
    }),

  /**
   * Refresh token for a provider
   */
  connectRefresh: lobehubSkillAuthProcedure
    .input(z.object({ provider: z.string() }))
    .mutation(async ({ input, ctx }) => {
      log('connectRefresh: provider=%s', input.provider);

      try {
        const response = await ctx.marketSDK.connect.refresh(input.provider);
        return {
          connection: response.connection,
          refreshed: response.refreshed,
        };
      } catch (error) {
        log('connectRefresh error: %O', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to refresh token: ${(error as Error).message}`,
        });
      }
    }),

  /**
   * Revoke connection for a provider
   */
  connectRevoke: lobehubSkillAuthProcedure
    .input(z.object({ provider: z.string() }))
    .mutation(async ({ input, ctx }) => {
      log('connectRevoke: provider=%s', input.provider);

      try {
        await ctx.marketSDK.connect.revoke(input.provider);
        return { success: true };
      } catch (error) {
        log('connectRevoke error: %O', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to revoke connection: ${(error as Error).message}`,
        });
      }
    }),

  /**
   * Export a file from sandbox and upload to S3, then create a persistent file record
   * This combines the previous getExportFileUploadUrl + execInSandbox + createFileRecord flow
   * Returns a permanent /f/:id URL instead of a temporary pre-signed URL
   */
  exportAndUploadFile: marketToolProcedure
    .input(exportAndUploadFileSchema)
    .mutation(async ({ input, ctx }) => {
      const { path, filename, topicId } = input;

      log('Exporting and uploading file: %s from path: %s in topic: %s', filename, path, topicId);

      try {
        const s3 = new FileS3();

        // Use date-based sharding for privacy compliance (GDPR, CCPA)
        const today = new Date().toISOString().split('T')[0];

        // Generate a unique key for the exported file
        const key = `code-interpreter-exports/${today}/${topicId}/${filename}`;

        // Step 1: Generate pre-signed upload URL
        const uploadUrl = await s3.createPreSignedUrl(key);
        log('Generated upload URL for key: %s', key);

        // Step 2: Use MarketService from ctx
        const market = ctx.marketService.market;

        // Step 3: Call sandbox's exportFile tool with the upload URL
        const response = await market.plugins.runBuildInTool(
          'exportFile',
          { path, uploadUrl },
          { topicId, userId: ctx.userId },
        );

        log('Sandbox exportFile response: %O', response);

        if (!response.success) {
          const errorCode = response.error?.code;
          const errorMessage = response.error?.message || 'Failed to export file from sandbox';

          // Check for authentication errors and throw UNAUTHORIZED
          if (
            errorCode === 'invalid_token' ||
            errorCode === 'token_expired' ||
            errorCode === 'unauthorized' ||
            errorMessage.toLowerCase().includes('invalid_token') ||
            errorMessage.toLowerCase().includes('token expired')
          ) {
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message:
                'Market authorization expired. An authorization dialog has been shown to the user. Please wait for the user to complete authorization and then retry the current task.',
            });
          }

          return {
            error: { message: errorMessage },
            filename,
            success: false,
          } as ExportAndUploadFileResult;
        }

        const result = response.data?.result;
        const uploadSuccess = result?.success !== false;

        if (!uploadSuccess) {
          return {
            error: { message: result?.error || 'Failed to upload file from sandbox' },
            filename,
            success: false,
          } as ExportAndUploadFileResult;
        }

        // Step 4: Get file metadata from S3 to verify upload and get actual size
        const metadata = await s3.getFileMetadata(key);
        const fileSize = metadata.contentLength;
        const mimeType = metadata.contentType || result?.mimeType || 'application/octet-stream';

        // Step 5: Create persistent file record using FileService
        // Generate a simple hash from the key (since we don't have the actual file content)
        const fileHash = sha256(key + Date.now().toString());

        const { fileId, url } = await ctx.fileService.createFileRecord({
          fileHash,
          fileType: mimeType,
          name: filename,
          size: fileSize,
          url: key, // Store S3 key
        });

        log('Created file record: fileId=%s, url=%s', fileId, url);

        return {
          fileId,
          filename,
          mimeType,
          size: fileSize,
          success: true,
          url, // This is the permanent /f/:id URL
        } as ExportAndUploadFileResult;
      } catch (error) {
        log('Error in exportAndUploadFile: %O', error);

        // Re-throw TRPCError as-is
        if (error instanceof TRPCError) {
          throw error;
        }

        const errorMessage = (error as Error).message;

        // Check for authentication errors
        if (
          errorMessage.toLowerCase().includes('invalid_token') ||
          errorMessage.toLowerCase().includes('token expired') ||
          errorMessage.toLowerCase().includes('unauthorized')
        ) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message:
              'Market authorization expired. An authorization dialog has been shown to the user. Please wait for the user to complete authorization and then retry the current task.',
          });
        }

        return {
          error: { message: errorMessage },
          filename,
          success: false,
        } as ExportAndUploadFileResult;
      }
    }),
});
