import { toolsClient } from '@/libs/trpc/client';
import {
  type CallToolResult,
  type ExecInSandboxInput,
  type ExportAndUploadFileInput,
  type ExportAndUploadFileResult,
} from '@/server/routers/tools/market';

class CloudSandboxService {
  /**
   * Call a cloud sandbox tool.
   * NOTE: this is the legacy sync path. Block D Phase 2 will replace it with
   * enqueue + listActive + poll once Block B lands (sandbox_jobs tRPC procedures).
   *
   * @param toolName - The name of the tool to call (e.g., 'runCommand', 'writeLocalFile')
   * @param params - The parameters for the tool
   * @param context - Session context (topicId, optional userId, toolCallId for durable async lookup)
   */
  async callTool(
    toolName: string,
    params: Record<string, any>,
    context: { toolCallId?: string; topicId: string; userId?: string },
  ): Promise<CallToolResult> {
    const input: ExecInSandboxInput = {
      params,
      toolName,
      topicId: context.topicId,
      userId: context.userId,
    };

    return toolsClient.market.execInSandbox.mutate(input);
  }

  /**
   * Export a file from sandbox and upload to S3, then create a persistent file record
   * This is a single call that combines: getUploadUrl + callTool(exportFile) + createFileRecord
   * Returns a permanent /f/:id URL instead of a temporary pre-signed URL
   * @param path - The file path in the sandbox
   * @param filename - The name of the file to export
   * @param topicId - The topic ID for organizing files
   */
  async exportAndUploadFile(
    path: string,
    filename: string,
    topicId: string,
  ): Promise<ExportAndUploadFileResult> {
    const input: ExportAndUploadFileInput = {
      filename,
      path,
      topicId,
    };

    return toolsClient.market.exportAndUploadFile.mutate(input);
  }
}

export const cloudSandboxService = new CloudSandboxService();
