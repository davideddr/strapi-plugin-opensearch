import { readFileSync } from 'node:fs';
import type { Core } from '@strapi/strapi';
import { Client, type ClientOptions } from '@opensearch-project/opensearch';
import type { ConnectionConfig, PluginConfig } from '../types';
import { PLUGIN_ID } from '../types';

const resolveCa = (ca: string) => (ca.includes('-----BEGIN') ? ca : readFileSync(ca, 'utf8'));

const buildOptions = (connection: ConnectionConfig): ClientOptions => {
  const { node, auth, ssl, requestTimeout, maxRetries } = connection;
  const options: ClientOptions = { node, requestTimeout, maxRetries };

  if (ssl) {
    options.ssl = {
      rejectUnauthorized: ssl.rejectUnauthorized ?? true,
      ...(ssl.ca ? { ca: resolveCa(ssl.ca) } : {}),
    };
  }

  if (auth.type === 'basic') {
    options.auth = { username: auth.username, password: auth.password };
    return options;
  }

  // SigV4: credentials come from the default AWS chain (env, profile, IMDS, ECS/EKS roles),
  // loaded lazily by the signer from the optional peer `@aws-sdk/credential-provider-node`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AwsSigv4Signer } = require('@opensearch-project/opensearch/aws-v3');
  return { ...options, ...AwsSigv4Signer({ region: auth.region, service: auth.service }) };
};

const client = ({ strapi }: { strapi: Core.Strapi }) => {
  let instance: Client | null = null;

  const getConfig = <K extends keyof PluginConfig>(key: K): PluginConfig[K] => strapi.plugin(PLUGIN_ID).config(key);

  return {
    getClient(): Client {
      if (!instance) {
        instance = new Client(buildOptions(getConfig('connection')));
      }
      return instance;
    },

    /** Resolves with the cluster info, rejects if the cluster is unreachable. */
    async ping() {
      const { body } = await this.getClient().info();
      return {
        clusterName: body.cluster_name,
        version: body.version.number,
        distribution: body.version.distribution,
      };
    },

    async close() {
      if (instance) {
        const current = instance;
        instance = null;
        await current.close();
      }
    },
  };
};

export default client;
