import { type DeviceAttachment } from '@lobechat/builtin-tool-remote-device';
import debug from 'debug';

const log = debug('lobe-server:device-proxy');

export interface DeviceStatusResult {
  deviceCount: number;
  online: boolean;
}

export interface DeviceSystemInfo {
  [key: string]: any;
}

export type { DeviceAttachment };

export class DeviceProxy {
  get isConfigured(): boolean {
    return false;
  }

  async queryDeviceStatus(userId: string): Promise<DeviceStatusResult> {
    return { deviceCount: 0, online: false };
  }

  async queryDeviceList(userId: string): Promise<DeviceAttachment[]> {
    return [];
  }

  async queryDeviceSystemInfo(
    userId: string,
    deviceId: string,
  ): Promise<DeviceSystemInfo | undefined> {
    return undefined;
  }

  async executeToolCall(
    params: { deviceId: string; userId: string },
    toolCall: { apiName: string; arguments: string; identifier: string },
    timeout = 30_000,
  ): Promise<{ content: string; error?: string; success: boolean }> {
    return {
      content: 'Device Gateway is not configured',
      error: 'GATEWAY_NOT_CONFIGURED',
      success: false,
    };
  }
}

export const deviceProxy = new DeviceProxy();
