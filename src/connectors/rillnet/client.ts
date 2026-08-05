import {
  RillnetRequestError,
  RillnetInvalidUrlError,
  RillnetDownloadError,
  type RillnetSnapResponse,
  type RillnetWarehouseMetaMap,
} from "./types";

export const RILLNET_API_ENDPOINT = "https://rillnet-app.vercel.app/api/gtalk-send";
export const RILLNET_META_ENDPOINT = "https://rillnet-app.vercel.app/wh_meta.json";

export class RillnetClient {
  /**
   * Requests signed snapshot URL from Rillnet endpoint
   */
  async requestSnapshotUrl(): Promise<{ downloadUrl: string; updatedAt: string }> {
    let response: Response;
    try {
      response = await fetch(RILLNET_API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "opssnap" }),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RillnetRequestError(`Failed to reach Rillnet API: ${message}`);
    }

    if (!response.ok) {
      throw new RillnetRequestError(
        `Rillnet opssnap request failed with status ${response.status}`,
        response.status
      );
    }

    const data: RillnetSnapResponse = await response.json();
    const downloadUrl = data.liveUrl || data.url;

    if (!downloadUrl || typeof downloadUrl !== "string") {
      throw new RillnetInvalidUrlError("Response did not contain a valid snapshot download URL");
    }

    const updatedAt = data.liveUpdated || data.updated || new Date().toISOString();

    return { downloadUrl, updatedAt };
  }

  /**
   * Downloads raw GZIP compressed snapshot buffer from signed URL
   */
  async downloadSnapshotBuffer(downloadUrl: string): Promise<ArrayBuffer> {
    let response: Response;
    try {
      response = await fetch(downloadUrl);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RillnetDownloadError(`Network error downloading snapshot: ${message}`);
    }

    if (!response.ok) {
      throw new RillnetDownloadError(
        `Snapshot download failed with status ${response.status}`,
        response.status
      );
    }

    try {
      return await response.arrayBuffer();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RillnetDownloadError(`Failed to read snapshot response buffer: ${message}`);
    }
  }

  /**
   * Fetches warehouse metadata mapping
   */
  async fetchWarehouseMeta(): Promise<RillnetWarehouseMetaMap> {
    try {
      const response = await fetch(RILLNET_META_ENDPOINT);
      if (!response.ok) return {};
      return await response.json();
    } catch {
      return {};
    }
  }
}
