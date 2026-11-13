/**
 * Prefixes every key with the plugin id. Not exported by `@strapi/strapi/admin` in v5: core
 * plugins ship the same helper locally.
 */
export const prefixPluginTranslations = (data: Record<string, string>, pluginId: string) =>
  Object.fromEntries(Object.entries(data).map(([key, value]) => [`${pluginId}.${key}`, value]));
