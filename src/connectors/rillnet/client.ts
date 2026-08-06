import { RillnetClient as RillnetIntegrationClient } from "../../integrations/rillnet";
import {
  RillnetRequestError,
  RillnetDownloadError,
  type RillnetWarehouseMetaMap,
} from "./types";

export const RILLNET_API_ENDPOINT = "https://rillnet-app.vercel.app/api/gtalk-send";
export const RILLNET_META_ENDPOINT = "https://rillnet-app.vercel.app/wh_meta.json";

export class RillnetClient {
  private client: RillnetIntegrationClient;

  constructor() {
    this.client = new RillnetIntegrationClient();
  }

  /**
   * Requests signed snapshot URL from Rillnet endpoint
   */
  async requestSnapshotUrl(): Promise<{ downloadUrl: string; updatedAt: string }> {
    try {
      const res = await this.client.requestSnapshotUrl();
      return {
        downloadUrl: res.downloadUrl,
        updatedAt: res.updatedAt,
      };
    } catch (err: any) {
      throw new RillnetRequestError(`Failed to reach Rillnet API: ${err.message}`);
    }
  }

  /**
   * Downloads raw GZIP compressed snapshot buffer from signed URL
   */
  async downloadSnapshotBuffer(downloadUrl: string): Promise<ArrayBuffer> {
    try {
      return await this.client.downloadSnapshot(downloadUrl);
    } catch (err: any) {
      throw new RillnetDownloadError(`Network error downloading snapshot: ${err.message}`);
    }
  }

  /**
   * Fetches warehouse metadata mapping
   */
  async fetchWarehouseMeta(): Promise<RillnetWarehouseMetaMap> {
    try {
      return await this.client.fetchWarehouseMeta();
    } catch {
      return {};
    }
  }
}
