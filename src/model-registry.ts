export interface ModelConfig {
  id: string;
}

export interface ModelRegistry<T extends ModelConfig> {
  models(): T[];
  resolve(model: string | undefined): T | undefined;
  defaultModel(envDefault: string | undefined, fallbackId: string): T;
}

export function createModelRegistry<T extends ModelConfig>(
  configs: T[],
  normalize: (model: string) => string | undefined,
): ModelRegistry<T> {
  const byId = new Map(configs.map((config) => [config.id, config]));

  return {
    models: () => [...byId.values()],
    resolve: (model) => {
      const id = normalize(model ?? "");
      if (!id) return undefined;
      return byId.get(id);
    },
    defaultModel: (envDefault, fallbackId) => {
      if (envDefault) {
        const fromEnv = byId.get(normalize(envDefault) ?? "");
        if (fromEnv) return fromEnv;
      }
      return byId.get(fallbackId)!;
    },
  };
}
