import { PLUGIN_ID } from './pluginId';
import { Initializer } from './components/Initializer';
import { PERMISSIONS } from './permissions';
import { getTranslation } from './utils/getTranslation';
import { prefixPluginTranslations } from './utils/prefixPluginTranslations';

import type { StrapiApp } from '@strapi/strapi/admin';

const plugin: StrapiApp['appPlugins'][string] = {
  register(app) {
    app.addSettingsLink(
      { id: PLUGIN_ID, intlLabel: { id: getTranslation('settings.section'), defaultMessage: 'OpenSearch' } },
      {
        id: `${PLUGIN_ID}-status`,
        to: PLUGIN_ID,
        intlLabel: { id: getTranslation('settings.link'), defaultMessage: 'Indices' },
        Component: () => import('./pages/Settings'),
        // Hides the link only: the admin routes enforce the same actions with their policies.
        permissions: PERMISSIONS.read,
      },
    );

    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: Initializer,
      isReady: false,
      name: PLUGIN_ID,
    });
  },

  async registerTrads({ locales }) {
    return Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = (await import(`./translations/${locale}.json`)) as {
            default: Record<string, string>;
          };
          return { data: prefixPluginTranslations(data, PLUGIN_ID), locale };
        } catch {
          return { data: {}, locale };
        }
      }),
    );
  },
};

export default plugin;
