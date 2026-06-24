import type { AuthoringDocumentV1 } from './authoringDocument';
import { bakePreparedDepthZeroTile } from './structuralBake';
import type { TileKey } from '../heightmap/tileKey';
import type { WorldConfig } from '../heightmap/worldConfig';
import { downsample2x2Children } from '../heightmap/lodBuilder';
import { prepareStructuralDocument, type PreparedStructuralDocument } from './geometry';

interface InitDepthZeroBakeRequest {
  id: number;
  type: 'init-depth-zero-bake';
  config: WorldConfig;
  document: AuthoringDocumentV1;
  waterLevel: number;
}

interface BakeDepthZeroTileRequest {
  id: number;
  type: 'bake-depth-zero-tile';
  tileX: number;
  tileY: number;
}

interface DownsampleLodTileRequest {
  id: number;
  type: 'downsample-lod-tile';
  tileSize: number;
  key: TileKey;
  children: ArrayBuffer[];
}

type BakeWorkerRequest = InitDepthZeroBakeRequest | BakeDepthZeroTileRequest | DownsampleLodTileRequest;

interface BakeWorkerResponse {
  id: number;
  key: TileKey;
  samples: ArrayBuffer;
}

interface BakeWorkerError {
  id: number;
  error: string;
}

let depthZeroState: { config: WorldConfig; prepared: PreparedStructuralDocument; waterLevel: number } | null = null;

self.onmessage = (event: MessageEvent<BakeWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'init-depth-zero-bake') {
      depthZeroState = {
        config: request.config,
        prepared: prepareStructuralDocument(request.document),
        waterLevel: request.waterLevel
      };
      return;
    }

    if (request.type === 'bake-depth-zero-tile') {
      if (!depthZeroState) throw new Error('Depth-zero bake worker was not initialized.');
      const samples = bakePreparedDepthZeroTile(depthZeroState.config, depthZeroState.prepared, depthZeroState.waterLevel, request.tileX, request.tileY);
      const response: BakeWorkerResponse = {
        id: request.id,
        key: { x: request.tileX, y: request.tileY, d: 0 },
        samples: samples.buffer
      };
      self.postMessage(response, [samples.buffer]);
      return;
    }

    const children = request.children.map((buffer) => new Uint16Array(buffer));
    const samples = downsample2x2Children(request.tileSize, children);
    const response: BakeWorkerResponse = {
      id: request.id,
      key: request.key,
      samples: samples.buffer
    };
    self.postMessage(response, [samples.buffer]);
  } catch (error) {
    const response: BakeWorkerError = {
      id: request.id,
      error: error instanceof Error ? error.message : 'Bake worker failed.'
    };
    self.postMessage(response);
  }
};
