export type WorldUnit = 'foot' | 'meter' | 'cm';

export interface WaterConfig {
  visible: boolean;
  level: number;
}

export interface WorldConfig {
  id: string;
  name: string;
  tileSize: number;
  unitSize: number;
  unit: WorldUnit;
  tilesPerSide: number;
  worldHeight: number;
  water: WaterConfig;
  createdAt: string;
  updatedAt: string;
  version: 1;
}

export interface WorldConfigInput {
  name: string;
  tileSize: number;
  unitSize: number;
  unit: WorldUnit;
  tilesPerSide: number;
  worldHeight: number;
}

export const DEFAULT_WORLD_INPUT: WorldConfigInput = {
  name: 'New World',
  tileSize: 1024,
  unitSize: 1,
  unit: 'foot',
  tilesPerSide: 16,
  worldHeight: 1024
};

export function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export function validateWorldConfig(input: WorldConfigInput): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('Name is required.');
  if (!Number.isInteger(input.tileSize) || input.tileSize < 2) errors.push('Tile size must be an integer greater than 1.');
  if (!isPowerOfTwo(input.tileSize)) errors.push('Tile size must be a power of two.');
  if (!Number.isFinite(input.unitSize) || input.unitSize <= 0) errors.push('Unit size must be greater than zero.');
  if (!isPowerOfTwo(input.tilesPerSide)) errors.push('World size must be a power-of-two tile count.');
  if (!Number.isFinite(input.worldHeight) || input.worldHeight <= 0) errors.push('World height must be greater than zero.');
  return errors;
}

export function createWorldConfig(input: WorldConfigInput, id = crypto.randomUUID()): WorldConfig {
  const errors = validateWorldConfig(input);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  const now = new Date().toISOString();
  return {
    ...input,
    id,
    name: input.name.trim(),
    water: { visible: false, level: 0 },
    createdAt: now,
    updatedAt: now,
    version: 1
  };
}

export function normalizeWaterConfig(water?: Partial<WaterConfig>): WaterConfig {
  return {
    visible: Boolean(water?.visible),
    level: Number.isFinite(water?.level) ? Number(water?.level) : 0
  };
}

export function normalizeWorldConfig(config: WorldConfig | (Omit<WorldConfig, 'worldHeight' | 'water'> & { maxElevation?: number; worldHeight?: number; water?: Partial<WaterConfig> })): WorldConfig {
  const maybeLegacy = config as WorldConfig & { maxElevation?: number; water?: Partial<WaterConfig> };
  return {
    ...maybeLegacy,
    worldHeight: maybeLegacy.worldHeight ?? maybeLegacy.maxElevation ?? DEFAULT_WORLD_INPUT.worldHeight,
    water: normalizeWaterConfig(maybeLegacy.water)
  };
}

export function getWorldLinearSize(config: Pick<WorldConfigInput, 'tileSize' | 'tilesPerSide' | 'unitSize'>): number {
  return config.tileSize * config.tilesPerSide * config.unitSize;
}

export function getWorldAreaSquareMiles(config: Pick<WorldConfigInput, 'tileSize' | 'tilesPerSide' | 'unitSize' | 'unit'>): number {
  const linearSize = getWorldLinearSize(config);
  const feetPerUnit: Record<WorldUnit, number> = {
    foot: 1,
    meter: 3.280839895,
    cm: 0.03280839895
  };
  const milesPerSide = (linearSize * feetPerUnit[config.unit]) / 5280;
  return milesPerSide * milesPerSide;
}

export function getMaxLodDepth(tilesPerSide: number): number {
  if (!isPowerOfTwo(tilesPerSide)) {
    throw new Error('LOD depth requires a power-of-two tile count.');
  }
  return Math.log2(tilesPerSide);
}

export function r16ToElevation(value: number, worldHeight: number): number {
  return (value / 65535) * worldHeight;
}

export function metersToWorldUnits(meters: number, config: Pick<WorldConfigInput, 'unit'>): number {
  const unitsPerMeter: Record<WorldUnit, number> = {
    foot: 3.280839895,
    meter: 1,
    cm: 100
  };
  return meters * unitsPerMeter[config.unit];
}
