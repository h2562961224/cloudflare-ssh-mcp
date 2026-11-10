import type { SshConfig } from './ssh';

export interface HostRegistration {
  binding: string;
  username: string;
  hostKey: string;
  privateKeySecret: string;
}

export interface HostConfig extends SshConfig {
  SSH_HOSTS?: Record<string, HostRegistration>;
  SSH_DEFAULT_HOST?: string;
  [name: string]: unknown;
}

export function listHosts(env: HostConfig) {
  if (!env.SSH_HOSTS) {
    return [{ host: 'default', username: env.SSH_USER, default: true }];
  }
  return Object.entries(env.SSH_HOSTS).map(([host, registration]) => ({
    host,
    username: registration.username,
    default: host === env.SSH_DEFAULT_HOST,
  }));
}

export function resolveHost(env: HostConfig, host?: string): SshConfig {
  if (!env.SSH_HOSTS) {
    if (host && host !== 'default') throw new Error('Unknown SSH host');
    return env;
  }
  const name = host ?? env.SSH_DEFAULT_HOST;
  if (!name || !Object.hasOwn(env.SSH_HOSTS, name)) {
    throw new Error('Unknown SSH host; use ssh_list_hosts to select a registered host');
  }
  const registration = env.SSH_HOSTS[name];
  const binding = env[registration.binding] as SshConfig['SSH_VPC'] | undefined;
  const privateKey = env[registration.privateKeySecret];
  if (!binding || typeof binding.connect !== 'function' || typeof privateKey !== 'string' || !privateKey) {
    throw new Error('Registered SSH host is missing its binding or private key secret');
  }
  return {
    SSH_VPC: binding,
    SSH_USER: registration.username,
    SSH_HOST_KEY: registration.hostKey,
    SSH_PRIVATE_KEY: privateKey,
  };
}
